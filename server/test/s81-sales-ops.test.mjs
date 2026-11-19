// S81（v0.95，K81）— 运营动作域：三类分流 / 日终修订覆盖与成交不重复入库红线 /
// 线索去重与归属（接受信息不全）/ 名册学习与代报提醒 / 汇总对账 / 表格 upsert 同步。
// fetch 注桩走真实请求构造路径（S78/S79 同款）；不 mock 数据库。
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupApp } from './helpers.mjs'
import { setSetting } from '../engine/settings.js'
import { parseLeadsMessage, parseLeadLine, parseCount, looksLikeLeadsMessage } from '../engine/opsParser.js'
import { insertLeadIfAbsent, opsSummary, syncAssistantsFromMembers, learnAssistantBinding, resolveAssistantByOpenId, listOpsPending } from '../engine/ops.js'
import { runSalesExtraction } from '../brain/salesExtract.js'
import { buildSalesDailyCard, } from '../brain/bot/cards.js'
import { buildSalesReportText } from '../brain/salesReport.js'
import { toOpsFields, toLeadFields, syncOpsToBitable } from '../brain/opsSync.js'

function stubFetch(routes) {
  const real = globalThis.fetch
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url)
    for (const [frag, responder] of routes) {
      if (u.includes(frag)) {
        const r = typeof responder === 'function' ? responder(u, opts) : responder
        if (r instanceof Response) return r
        return new Response(JSON.stringify(r ?? {}), { status: 200 })
      }
    }
    throw new Error('unexpected fetch: ' + u)
  }
  return { restore: () => { globalThis.fetch = real } }
}
const TOKEN_OK = ['/auth/v3/tenant_access_token', { code: 0, tenant_access_token: 't-s81' }]
const msg = (id, text, sec, sender = 'ou_seller_1') => ({
  message_id: id, msg_type: 'text', create_time: String(sec), sender: { id: sender },
  body: { content: JSON.stringify({ text }) },
})

const REPORT = `【助手号运营数据每日汇报】
日期：2026年11月19日
运营账号：漫漫（气球）
当日销售总金额：¥3,500
销售产品：365连麦
新增好友：5人
被动触达用户：18
主动触达用户：32次
用户线索（微信名、微信号、意向产品、来源渠道）：
1. 王姐，wangjie_88，商业下午茶，来自小红书
朋友圈数量：3条
被点赞评论互动：12
主动点赞评论互动：41次`

const DEAL = `【销售成交报单】
成交日期：2026年11月19日
成交金额：¥2,000
成交产品：365连麦
成交小助手：漫漫
客户昵称/标识：王姐
订单号：S81DEAL0001`

const SCATTER_LEAD = `【用户线索】
微信名：张三
微信号：zs123456
意向产品：365连麦
来源渠道：朋友介绍`

let ctx
beforeAll(async () => {
  ctx = await setupApp()
  setSetting(ctx.db, 'im.feishu', { appId: 'cli_s81', appSecret: 'sec_s81' })
})
afterAll(() => ctx?.db.close())

describe('S81-1/S81-2/S81-3 三类分流与日终红线（抽取管线集成）', () => {
  it('S81-1/S81-2/S81-3: 同轮四类消息正确路由；日报金额不进 sales_records；线索去重合流；轮末合并回执', async () => {
    syncAssistantsFromMembers(ctx.db, [{ openId: 'ou_seller_1', name: '漫漫' }])
    const items = [
      msg('om_o1', REPORT, 50001),          // 日终汇总（含线索区块：王姐）
      msg('om_d1', DEAL, 50002),            // 成交报单（漫漫 ¥2000 —— 对账将差 ¥1500）
      msg('om_l1', SCATTER_LEAD, 50003),    // 零散线索（张三）
      msg('om_l2', `【用户线索】
微信名：王姐
微信号：wangjie_88
意向产品：商业下午茶`, 50004), // 与日报区块重复（同微信号）→ 判重
      msg('om_n1', '今天大家都辛苦啦～', 50005), // 噪音
    ]
    const s = stubFetch([TOKEN_OK, ['/im/v1/messages', () => ({ code: 0, data: { has_more: false, items } })]])
    const sent = []
    try {
      const r = await runSalesExtraction(ctx.db, { send: (t) => sent.push(t) })
      expect(r.recorded).toBe(1)
      expect(r.opsReports).toBe(1)
      expect(r.leads).toBe(2) // 日报区块王姐 + 零散张三（om_l2 重复不计）
      expect(r.noise).toBe(1)
      // 轮末合并回执一条
      expect(sent.filter((t) => t.includes('恭喜'))).toHaveLength(1)
      expect(sent[0]).toContain('1 条成交')
      expect(sent[0]).toContain('1 份运营日报')
      expect(sent[0]).toContain('2 条新线索')
      // 红线：日报金额 ¥3500 不进 sales_records（只有一笔 ¥2000 报单）
      const amounts = ctx.db.prepare('SELECT amount FROM sales_records').all().map((x) => x.amount)
      expect(amounts).toEqual([2000])
      // 重复线索判重：om_l2 台账 duplicate
      const l2 = ctx.db.prepare("SELECT status FROM sales_messages WHERE message_id = 'om_l2'").get()
      expect(l2.status).toBe('duplicate')
      // 日报台账 ops_report
      const o1 = ctx.db.prepare("SELECT status, detail FROM sales_messages WHERE message_id = 'om_o1'").get()
      expect(o1.status).toBe('ops_report')
      expect(o1.detail).toContain('r1')
    } finally { s.restore() }
  })

  it('S81-2: 修订覆盖——重发更新 revision、同发言人静默；换 open_id 提醒后仍覆盖；金额口径更新', async () => {
    const items = [msg('om_o2', REPORT.replace('¥3,500', '¥3,600'), 51001)] // 同发言人修正金额
    let s = stubFetch([TOKEN_OK, ['/im/v1/messages', () => ({ code: 0, data: { has_more: false, items } })]])
    const sent = []
    try {
      const r = await runSalesExtraction(ctx.db, { send: (t) => sent.push(t) })
      expect(r.opsRevised).toBe(1)
      expect(r.opsReports).toBe(0)
      const row = ctx.db.prepare("SELECT revision, reported_amount FROM ops_reports WHERE account = '漫漫' AND day = '2026-11-19'").get()
      expect(row.revision).toBe(2)
      expect(row.reported_amount).toBe(3600)
      expect(sent.some((t) => t.includes('与以往发言人不同'))).toBe(false) // 同发言人：静默覆盖
    } finally { s.restore() }

    // 换人代报（ou_other 用「漫漫」名发）→ 温和提醒 + 仍覆盖
    items.length = 0
    items.push(msg('om_o3', REPORT.replace('¥3,500', '¥3,700'), 51002, 'ou_other'))
    s = stubFetch([TOKEN_OK, ['/im/v1/messages', () => ({ code: 0, data: { has_more: false, items } })]])
    try {
      const r = await runSalesExtraction(ctx.db, { send: (t) => sent.push(t) })
      expect(r.opsRevised).toBe(1)
      expect(sent.some((t) => t.includes('漫漫') && t.includes('与以往发言人不同'))).toBe(true) // 温和提醒
      const row = ctx.db.prepare("SELECT revision, reported_amount FROM ops_reports WHERE account = '漫漫' AND day = '2026-11-19'").get()
      expect(row.revision).toBe(3)
      expect(row.reported_amount).toBe(3700) // 仍覆盖（不拦截）
    } finally { s.restore() }
  })

  it('S81-2: 日报缺账号/日期 → pending 提醒不入库', async () => {
    const items = [msg('om_o4', REPORT.split('\n').filter((l) => !l.startsWith('运营账号')).join('\n'), 52001)]
    const s = stubFetch([TOKEN_OK, ['/im/v1/messages', () => ({ code: 0, data: { has_more: false, items } })]])
    const sent = []
    try {
      const r = await runSalesExtraction(ctx.db, { send: (t) => sent.push(t) })
      expect(r.pending).toBe(1)
      expect(sent.some((t) => t.includes('运营账号') && t.includes('补发'))).toBe(true)
      expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM ops_reports WHERE day = '2026-11-19' AND revision >= 4").get().n).toBe(0)
    } finally { s.restore() }
  })
})

describe('S81-3 线索解析与去重（纯函数 + 数据层）', () => {
  it('S81-3: 信息不全可接受——空行/无字段词/单字段都能解析或安全跳过', () => {
    expect(parseCount('5人')).toBe(5)
    expect(parseCount('abc')).toBeNull()
    expect(parseLeadLine('王姐，wangjie_88，商业下午茶，来自小红书').wechatId).toBe('wangjie_88')
    expect(parseLeadLine('只有名字')).toEqual(expect.objectContaining({ wechatName: '只有名字' }))
    expect(parseLeadLine('')).toBeNull()
    const leads = parseLeadsMessage(SCATTER_LEAD)
    expect(leads).toHaveLength(1)
    expect(leads[0]).toMatchObject({ wechatName: '张三', wechatId: 'zs123456', intentProduct: '365连麦', sourceChannel: '朋友介绍' })
    expect(looksLikeLeadsMessage('线索一个：李四，lisi_abc，想要私董，来自抖音')).toBe(true)
    expect(looksLikeLeadsMessage('加油冲业绩！')).toBe(false)
  })
  it('S81-3: (账号,微信号) 去重；无微信号按 (账号,日,微信名) 组合去重', () => {
    const db = ctx.db
    const a = insertLeadIfAbsent(db, { wechatName: 'A', wechatId: 'wx_a', intentProduct: 'x' }, { messageId: 'm1', day: '2026-11-19', account: '漫漫' })
    expect(a).toBeTruthy()
    expect(insertLeadIfAbsent(db, { wechatName: 'A', wechatId: 'wx_a' }, { messageId: 'm2', day: '2026-11-19', account: '漫漫' })).toBeNull() // 微信号撞
    expect(insertLeadIfAbsent(db, { wechatName: 'B', wechatId: '' }, { messageId: 'm3', day: '2026-11-19', account: '漫漫' })).toBeTruthy()
    expect(insertLeadIfAbsent(db, { wechatName: 'B', wechatId: '' }, { messageId: 'm4', day: '2026-11-19', account: '漫漫' })).toBeNull() // 组合撞
    expect(insertLeadIfAbsent(db, { wechatName: 'B', wechatId: '' }, { messageId: 'm5', day: '2026-11-20', account: '漫漫' })).toBeTruthy() // 跨日不撞
  })
  it('S81-4: 名册——群成员灌表（名册名=群昵称）、改名生效、反查、共现学习 mismatch', () => {
    const db = ctx.db
    const before = db.prepare('SELECT COUNT(*) AS n FROM sales_assistants').get().n
    const added = syncAssistantsFromMembers(db, [{ openId: 'ou_zhang', name: '张三丰' }, { openId: 'ou_seller_1', name: '漫漫' }])
    expect(added).toBe(1) // ou_seller_1 已在册跳过
    expect(db.prepare('SELECT COUNT(*) AS n FROM sales_assistants').get().n).toBe(before + 1)
    const zhang = db.prepare("SELECT * FROM sales_assistants WHERE open_id = 'ou_zhang'").get()
    expect(zhang.assistant_name).toBe('张三丰') // 名册名初值=群昵称
    db.prepare('UPDATE sales_assistants SET assistant_name = ?, status = ?, bound_at = ? WHERE id = ?').run('小闪', 'confirmed', Date.now(), zhang.id)
    expect(resolveAssistantByOpenId(db, 'ou_zhang')).toBe('小闪')
    // 共现学习：confirmed 的「小闪」名下 ou_zhang；ou_li 用「小闪」名发 → mismatch
    expect(learnAssistantBinding(db, { assistantName: '小闪', openId: 'ou_li' })).toBe('mismatch')
    expect(learnAssistantBinding(db, { assistantName: '新助手甲', openId: 'ou_new1' })).toBe('learned') // 未知名+未知人 → candidate 学习
    expect(learnAssistantBinding(db, { assistantName: '新助手甲', openId: 'ou_new1' })).toBe('ok') // 再共现 → confirmed（内部升级）
    expect(db.prepare("SELECT status FROM sales_assistants WHERE open_id = 'ou_new1'").get().status).toBe('confirmed')
  })
})

describe('S81-5 汇总与对账 + 播报三节', () => {
  it('S81-5: opsSummary 行/合计/对账差；卡片与降级文本三节渲染', () => {
    const db = ctx.db
    // 已有数据：漫漫 2026-11-19 报单 ¥2000、日报 r3 ¥3700（前序 it 落）；补一笔无日报账号的报单
    db.prepare(`INSERT INTO sales_records (message_id, order_no, deal_day, deal_ts, amount, product, assistant, customer_nick, source, created_at)
      VALUES ('om_extra', 'X1', '2026-11-19', 0, 500, '365连麦', '光光', 'x', 'bot', ?)`).run(Date.now())
    const o = opsSummary(db, { day: '2026-11-19' })
    const mm = o.rows.find((r) => r.account === '漫漫')
    expect(mm).toBeTruthy()
    expect(mm.reportedAmount).toBe(3700)
    expect(mm.actualAmount).toBe(2000)
    expect(mm.diff).toBe(1700) // 3700 - 2000
    const gg = o.rows.find((r) => r.account === '光光') // 无日报但有报单 → extra 行
    expect(gg.reportedAmount).toBeNull()
    expect(gg.actualAmount).toBe(500)
    expect(o.totals.actualAmount).toBe(2500)

    const sales = { day: '2026-11-19', today: { count: 2, amount: 2500 }, month: { count: 2, amount: 2500 }, byProduct: [{ product: '365连麦', n: 2, amount: 2500 }], byAssistant: [], pendingToday: 0 }
    const card = buildSalesDailyCard({ day: '2026-11-19', sales, ops: o })
    const flat = JSON.stringify(card)
    expect(card.header.title.content).toContain('销售日报 2026-11-19')
    expect(flat).toContain('今日运营动作')
    expect(flat).toContain('漫漫')
    expect(flat).toContain('对账')
    expect(flat).toContain('1,700')
    const text = buildSalesReportText({ day: '2026-11-19', sales, ops: o })
    expect(text).toContain('今日运营动作')
    expect(text).toContain('漫漫：好友5 触达32/18 朋友圈3 线索')
    expect(text).toContain('差 ¥1,700')
  })
})

describe('S81-6 表格同步（upsert + insert-only）', () => {
  it('S81-6: 未配表静默跳过；日报 create→修订 PATCH；线索 insert-only；失败不阻塞', async () => {
    const db = ctx.db
    // 未配 opsTableId/leadsTableId（显式清空——默认值已是生产表 id）→ 跳过
    setSetting(db, 'sales', { opsTableId: '', leadsTableId: '' })
    const r0 = await syncOpsToBitable(db)
    expect(r0.skipped).toBe(true)

    setSetting(db, 'sales', { opsTableId: 'tblOPS', leadsTableId: 'tblLEAD' })
    const bodies = []
    const s = stubFetch([
      TOKEN_OK,
      ['/bitable/v1/apps/', (u, opts) => {
        bodies.push({ url: u, method: opts.method, body: opts.body ? JSON.parse(opts.body) : null })
        if (opts.method === 'POST') return { code: 0, data: { records: [{ id: 'recOPS_' + bodies.length }, { id: 'recLEAD_' + bodies.length }] } }
        return { code: 0, data: { record: {} } }
      }],
    ])
    try {
      const r1 = await syncOpsToBitable(db)
      expect(r1.reports.created + r1.reports.updated).toBeGreaterThanOrEqual(1) // 漫漫日报（r3 未同步过 → create）
      expect(r1.leads.created).toBeGreaterThanOrEqual(1) // 线索批
      const create = bodies.find((b) => b.method === 'POST')
      expect(create.url).toContain('tblOPS')
      const f = create.body.records[0].fields
      expect(f.运营账号).toBe('漫漫') // 单选/文本字段字符串（1254062 口径）
      expect(f.对账差异).toBe(1700) // 同步时现算
      expect(typeof f.日期).toBe('number')
      expect(f.来源).toBe('群日报')

      // 修订：改金额 → synced_at < updated_at → PATCH 既有行
      db.prepare("UPDATE ops_reports SET reported_amount = 4000, updated_at = ? WHERE account = '漫漫' AND day = '2026-11-19'").run(Date.now())
      bodies.length = 0
      const r2 = await syncOpsToBitable(db)
      expect(r2.reports.updated).toBeGreaterThanOrEqual(1)
      const patch = bodies.find((b) => b.method === 'PUT')
      expect(patch).toBeTruthy()
      expect(patch.url).toContain('/records/recOPS_')
      expect(patch.body.fields.日报口径销售额).toBe(4000)
      // 再跑：无脏行 → 零写入
      bodies.length = 0
      const r3 = await syncOpsToBitable(db)
      expect(r3.reports.created + r3.reports.updated).toBe(0)
      expect(listOpsPending(db, {}).length).toBe(0)
    } finally { s.restore() }
  })
  it('S81-6: toLeadFields 字段映射', () => {
    const f = toLeadFields({ day: '2026-11-19', account: '漫漫', wechatName: '王姐', wechatId: 'w88', intentProduct: '下午茶', sourceChannel: '小红书', leadSource: 'digest', rawText: '原文', messageId: 'om_x' })
    expect(f.线索来源).toBe('日终汇总')
    expect(f.微信名).toBe('王姐')
    expect(typeof f.记录日期).toBe('number')
    void toOpsFields
  })
})
