// S79（v0.94，design.md K79）— 销售成交登记域：模板解析归一 / 双幂等 / 噪音与 LLM 兜底 /
// 缺字段回执 / 汇总统计（北京日界）/ 多维表格同步补推 / 配置默认值与开关。
// 集成断言经 globalThis.fetch 注桩走真实请求构造路径（S78 同款）；不 mock 数据库（每文件临时真库）。
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupApp } from './helpers.mjs'
import { scriptedLlm } from './bot-kit.mjs'
import { setSetting, getSetting } from '../engine/settings.js'
import { parseReport, parseAmount, parseDealDate, looksLikeReport } from '../engine/salesParser.js'
import { runSalesExtraction } from '../brain/salesExtract.js'
import { syncPendingToBitable } from '../brain/salesSync.js'
import { salesSummary, listSalesRecords, insertSalesRecord, recordSalesMessage } from '../engine/sales.js'
import { dailySalesReport, buildSalesReportText } from '../brain/salesReport.js'
import { dueTasks } from '../brain/scheduler.js'

function stubFetch(routes) {
  const calls = []
  const real = globalThis.fetch
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url)
    calls.push({ url: u, method: opts.method || 'GET', body: opts.body })
    for (const [frag, responder] of routes) {
      if (u.includes(frag)) {
        const r = typeof responder === 'function' ? responder(u, opts) : responder
        if (r instanceof Response) return r
        return new Response(JSON.stringify(r ?? {}), { status: 200 })
      }
    }
    throw new Error('unexpected fetch: ' + u)
  }
  return { calls, restore: () => { globalThis.fetch = real } }
}

const TOKEN_OK = ['/auth/v3/tenant_access_token', { code: 0, tenant_access_token: 't-s79' }]
const msg = (id, text, sec, extra = {}) => ({
  message_id: id, msg_type: 'text', create_time: String(sec), sender: { id: 'ou_sales_1' },
  body: { content: JSON.stringify({ text }) }, ...extra,
})

const FULL_REPORT = `【销售成交报单】
成交日期：2026年11月18日
成交金额：¥12,800
成交产品：26女商私董
成交小助手：漫漫（气球）
客户昵称/标识：吉莹
订单号：856933389853563
付款平台：对公转账
付款账号或交易号：TX998
成交凭证：截图
是否属于自营产品：是
是否涉及分销：否
备注：老客户续费`

let ctx
beforeAll(async () => {
  ctx = await setupApp()
  setSetting(ctx.db, 'im.feishu', { appId: 'cli_s79', appSecret: 'sec_s79' })
})
afterAll(() => ctx?.db.close())

describe('S79-1 模板报单确定性解析（归一化，无 LLM）', () => {
  it('S79-1: 标准模板全字段——金额千分位/名册/枚举/布尔全归一', () => {
    const { matched, fields, missing } = parseReport(FULL_REPORT)
    expect(matched).toBe(true)
    expect(missing).toEqual([])
    expect(fields.dealDay).toBe('2026-11-18')
    expect(fields.amount).toBe(12800)
    expect(fields.product).toBe('2026女商私董')
    expect(fields.assistant).toBe('漫漫')
    expect(fields.customerNick).toBe('吉莹')
    expect(fields.orderNo).toBe('856933389853563')
    expect(fields.payPlatform).toBe('线下')
    expect(fields.tradeNo).toBe('TX998')
    expect(fields.selfOwned).toBe('是')
    expect(fields.distribution).toBe('否')
    expect(fields.note).toBe('老客户续费')
  })
  it('S79-1: 金额形态——万元/半角逗号/纯数字；非法为 null（不猜）', () => {
    expect(parseAmount('3.5万')).toBe(35000)
    expect(parseAmount('0.35万')).toBe(3500)
    expect(parseAmount('¥2,990.00')).toBe(2990)
    expect(parseAmount('2999元')).toBe(2999)
    expect(parseAmount('待定')).toBeNull()
  })
  it('S79-1: 日期形态——中文/斜杠/月日缺省当年（未来归明年）/相对词（K16：显式传 today 锚）', () => {
    const opt = { today: '2026-11-18' }
    expect(parseDealDate('2026-11-18', opt)).toBe('2026-11-18')
    expect(parseDealDate('2026/11/18', opt)).toBe('2026-11-18')
    expect(parseDealDate('11-18', opt)).toBe('2026-11-18')
    expect(parseDealDate('11-20', opt)).toBe('2026-11-20') // 近期未来单：正常今年
    expect(parseDealDate('12-30', opt)).toBe('2026-12-30') // 一个月后的未来单：今年
    expect(parseDealDate('1-15', opt)).toBe('2027-01-15') // 次年月日 → 明年
    expect(parseDealDate('3-15', opt)).toBe('2027-03-15') // 已过半年前月日 = 下一周期
    expect(parseDealDate('今天', opt)).toBe('2026-11-18')
    expect(parseDealDate('昨天', opt)).toBe('2026-11-17')
    expect(parseDealDate('下周三', opt)).toBeNull()
  })
})

describe('S79-2/S79-3/S79-4 抽取管线（fetch 注桩，真实请求路径）', () => {
  it('S79-2: message_id 重放零重复；同订单号不同消息判重；无订单号组合查重；无新成交轮静默', async () => {
    const items = [msg('om_t1', FULL_REPORT, 10001)]
    const s = stubFetch([TOKEN_OK, ['/im/v1/messages', () => ({ code: 0, data: { has_more: false, items } })]])
    const sent = []
    const send = (t) => sent.push(t)
    try {
      const r1 = await runSalesExtraction(ctx.db, { send })
      expect(r1.recorded).toBe(1)
      expect(sent).toEqual(['收到 1 条成交信息入库，恭喜！']) // 轮末汇总回执（不逐条刷屏）
      const r2 = await runSalesExtraction(ctx.db, { send }) // 同消息重放
      expect(r2.recorded).toBe(0)
      expect(listSalesRecords(ctx.db, {}).length).toBe(1)

      items.length = 0 // 换消息：同订单号不同 message_id
      items.push(msg('om_t2', FULL_REPORT.replace('¥12,800', '¥12,800 '), 10002))
      const r3 = await runSalesExtraction(ctx.db, { send })
      expect(r3.duplicates).toBe(1)
      expect(listSalesRecords(ctx.db, {}).length).toBe(1)

      // 无订单号组合查重：库内已有无订单号记录（迁移/人工数据），同 客户+日+金额 报单再来判重。
      // （无订单号的新报单本身会进 pending——S79-4 缺关键字段不落账，故用直插构造存量。）
      const noOrder = FULL_REPORT.split('\n').filter((l) => !l.startsWith('订单号')).join('\n')
      insertSalesRecord(ctx.db, {
        messageId: 'om_seed_no_order', orderNo: '', dealDay: '2026-11-18', dealTs: Date.parse('2026-11-18T00:00:00+08:00'),
        amount: 12800, product: '2026女商私董', assistant: '漫漫', customerNick: '吉莹', source: 'manual',
      })
      items.length = 0
      items.push(msg('om_t3b', noOrder, 10004)) // 同客户+同日+同金额、不同消息
      const r4 = await runSalesExtraction(ctx.db, { send })
      expect(r4.duplicates).toBe(1)
      expect(listSalesRecords(ctx.db, {}).length).toBe(2) // 有订单 1 + 无订单 1
      expect(sent.length).toBe(1) // 重放/判重轮全部静默（重复不回执，台账留痕）
    } finally { s.restore() }
  })

  it('S79-3: 纯聊天/目标讨论噪音确定性跳过（零 LLM）；口语化报单走 LLM 兜底同校验落库', async () => {
    const { calls, llm } = scriptedLlm(JSON.stringify({
      isReport: true, confidence: 0.9,
      fields: { dealDate: '2026-11-18', amount: '12800', orderNo: '856', product: '1v1咨询', assistant: '小胖', customerNick: '王总' },
    }))
    const items = [
      msg('om_n1', '加油冲业绩！', 10101),
      msg('om_n2', '这个月冲30万成交目标！', 10102), // 裸「成交」=目标讨论，非强信号
      msg('om_n3', '出单了！客户王总 12800 订单号 856', 10103),
      msg('om_n4', '', 10104, { msg_type: 'image' }), // 图片消息空文本
    ]
    const s = stubFetch([TOKEN_OK, ['/im/v1/messages', () => ({ code: 0, data: { has_more: false, items } })]])
    try {
      const sent = []
      const r = await runSalesExtraction(ctx.db, { llm, send: (t) => sent.push(t) })
      expect(r.noise).toBe(3) // 闲聊 + 目标讨论 + 图片
      expect(r.llmUsed).toBe(1) // 只有口语化报单烧 LLM
      expect(calls.length).toBe(1)
      expect(r.recorded).toBeGreaterThanOrEqual(1)
      const rec = listSalesRecords(ctx.db, { fromDay: '2026-11-18', toDay: '2026-11-18' }).find((x) => x.orderNo === '856')
      expect(rec).toBeTruthy()
      expect(rec.amount).toBe(12800)
      expect(rec.product).toBe('1V1商业咨询') // 兜底结果同样过名册归一
      expect(sent.filter((t) => t.includes('恭喜'))).toHaveLength(1) // 一条汇总恭喜，噪音零逐条回执
    } finally { s.restore() }
  })

  it('S79-4: 模板缺关键字段——不落账、群回执列缺失项；补发同订单号合流不重复', async () => {
    const ORDER = '856P4ORDER0001'
    const incomplete = FULL_REPORT.split('\n').filter((l) => !l.startsWith('成交金额')).join('\n').replace('856933389853563', ORDER)
    const items = [msg('om_p1', incomplete, 10201)]
    const s = stubFetch([TOKEN_OK, ['/im/v1/messages', () => ({ code: 0, data: { has_more: false, items } })]])
    const sent = []
    try {
      const r = await runSalesExtraction(ctx.db, { send: (t) => sent.push(t) })
      expect(r.pending).toBe(1)
      expect(r.recorded).toBe(0)
      expect(sent.some((t) => t.includes('成交金额') && t.includes('补发'))).toBe(true)

      items.length = 0 // 补发完整报单（新消息，同订单号）
      items.push(msg('om_p2', FULL_REPORT.replace('856933389853563', ORDER), 10202))
      const r2 = await runSalesExtraction(ctx.db, { send: (t) => sent.push(t) })
      expect(r2.recorded).toBe(1)
      const rows = listSalesRecords(ctx.db, {}).filter((x) => x.orderNo === ORDER)
      expect(rows.length).toBe(1) // 补发合流：该订单仅一条记录
    } finally { s.restore() }
  })
})

describe('S79-6 多维表格同步（失败补推）', () => {
  it('S79-6: 成功回填 record_id；失败不回填不阻塞，恢复后补推', async () => {
    ctx.db.prepare('DELETE FROM sales_records').run() // 隔离：本轮只含同步用例的两条
    // 造两条未同步记录（直插数据层）
    const a = insertSalesRecord(ctx.db, {
      messageId: 'om_sync1', orderNo: 'SY1', dealDay: '2026-11-18', dealTs: Date.parse('2026-11-18T00:00:00+08:00'),
      amount: 999, product: '365连麦', assistant: '小胖', customerNick: '同步测试A', payPlatform: '微信',
    })
    const b = insertSalesRecord(ctx.db, {
      messageId: 'om_sync2', orderNo: 'SY2', dealDay: '2026-11-18', dealTs: Date.parse('2026-11-18T00:00:00+08:00'),
      amount: 1999, product: '播客闭门会', assistant: '漫漫', customerNick: '同步测试B',
    })
    const fail = stubFetch([TOKEN_OK, ['/bitable/v1/apps/', () => new Response('boom', { status: 500 })]])
    try {
      const r1 = await syncPendingToBitable(ctx.db)
      expect(r1.synced).toBe(0)
      expect(r1.error).toBeTruthy() // 失败不抛：调用方不阻塞
    } finally { fail.restore() }

    const bodies = []
    const ok = stubFetch([TOKEN_OK, ['/bitable/v1/apps/', (u, opts) => {
      bodies.push(JSON.parse(opts.body))
      return { code: 0, data: { records: [{ id: 'recSY1' }, { id: 'recSY2' }] } } // 真实形态：record_id 平铺在 records[i].id
    }]])
    try {
      const r2 = await syncPendingToBitable(ctx.db)
      expect(r2.synced).toBe(2)
      const rows = listSalesRecords(ctx.db, {}).filter((x) => ['SY1', 'SY2'].includes(x.orderNo))
      expect(rows.every((x) => x.syncedRecordId)).toBe(true)
      // 字段映射：select 数组 / datetime 毫秒 / 来源
      const f = bodies[0].records[0].fields
      expect(f.金额).toBe(999)
      expect(f.付款平台).toBe('微信') // v1 应用身份单选须字符串（1254062 实证）
      expect(f.来源).toBe('群报单')
      expect(f.源消息ID).toBe('om_sync1')
      expect(typeof f.成交日期).toBe('number')
      void a; void b
    } finally { ok.restore() }
  })
})

describe('S79-5 汇总统计与每日播报（北京日界，日级幂等）', () => {
  it('S79-5: 今日/本月/按小助手分布/待补发数——全部从 sales_records|sales_messages 计算', () => {
    ctx.db.prepare('DELETE FROM sales_records').run()
    ctx.db.prepare('DELETE FROM sales_messages').run()
    const ts = (d) => Date.parse(`${d}T10:00:00+08:00`)
    insertSalesRecord(ctx.db, { messageId: 'om_s1', orderNo: 'S1', dealDay: '2026-11-18', dealTs: ts('2026-11-18'), amount: 12800, product: '2026女商私董', assistant: '漫漫', customerNick: 'c1' })
    insertSalesRecord(ctx.db, { messageId: 'om_s2', orderNo: 'S2', dealDay: '2026-11-18', dealTs: ts('2026-11-18'), amount: 2999, product: '商业下午茶·上桌', assistant: '小胖', customerNick: 'c2' })
    insertSalesRecord(ctx.db, { messageId: 'om_s3', orderNo: 'S3', dealDay: '2026-11-17', dealTs: ts('2026-11-17'), amount: 365, product: '365连麦', assistant: '漫漫', customerNick: 'c3' })
    insertSalesRecord(ctx.db, { messageId: 'om_s4', orderNo: 'S4', dealDay: '2026-10-30', dealTs: ts('2026-10-30'), amount: 9801, product: '播客闭门会', assistant: '小闪', customerNick: 'c4' })
    recordSalesMessage(ctx.db, { messageId: 'om_s5', chatId: 'oc_test', text: 'x', ts: ts('2026-11-18'), status: 'pending_fields', detail: '缺 成交金额' })

    const s = salesSummary(ctx.db, { day: '2026-11-18' })
    expect(s.today).toEqual({ count: 2, amount: 15799 })
    expect(s.month).toEqual({ count: 3, amount: 16164 }) // 11 月：18 日 2 + 17 日 1
    expect(s.pendingToday).toBe(1)
    const top = s.byAssistant.find((x) => x.assistant === '漫漫')
    expect(top).toEqual({ assistant: '漫漫', n: 2, amount: 13165 })
    const prod = s.byProduct.find((x) => x.product === '2026女商私董')
    expect(prod).toEqual({ product: '2026女商私董', n: 1, amount: 12800 })
    expect(buildSalesReportText(s)).toContain('今日成交 2 单')
    expect(buildSalesReportText(s)).toContain('15,799')
  })

  it('S79-5: 每日播报为汇总卡片（K41 模板）；卡片失败降级文本；日级幂等不重发', async () => {
    const D = '2026-11-18' // 与上一 it 落的数据同日（显式传 day，不依赖真实时钟）
    const mk = (cards, texts, failCard = false) => ({
      card: async (c) => { if (failCard) throw new Error('card boom'); cards.push(c) },
      text: async (t) => texts.push(t),
    })
    // 成功路径：只发卡片
    const cards = []; const texts = []
    const r1 = await dailySalesReport(ctx.db, { send: mk(cards, texts), force: true, day: D })
    expect(r1.pushed).toBe(true)
    expect(cards.length).toBe(1)
    expect(texts.length).toBe(0)
    const c = cards[0]
    expect(c.header.template).toBe('green')
    expect(c.header.title.content).toContain(`销售日报 ${D}`)
    const flat = JSON.stringify(c)
    expect(flat).toContain('今日成交 2 单')
    expect(flat).toContain('15,799')
    expect(flat).toContain('产品') // column_set 明细表头（产品/单数/金额）
    expect(flat).toContain('2026女商私董')
    expect(flat).toContain('12,800')
    expect(flat).not.toContain('小助手榜') // 用户拍板：不发排行榜

    // 降级路径：卡片发送失败 → 纯文本补发（S55 必达），内容口径与卡片一致
    const c2 = []; const t2 = []
    const r2 = await dailySalesReport(ctx.db, { send: mk(c2, t2, true), force: true, day: D })
    expect(r2.pushed).toBe(true)
    expect(r2.degraded).toBe(true)
    expect(c2.length).toBe(0) // 卡片未送达
    expect(t2.length).toBe(1)
    expect(t2[0]).toContain('今日成交 2 单')
    expect(t2[0]).toContain('15,799')

    // 日级幂等：当日已有成功播报（scheduler_runs ok 行）不重发
    ctx.db.prepare(
      `INSERT INTO scheduler_runs (task, origin, started_at, duration_ms, ok, summary, created_at)
       VALUES ('salesReport', 'cron', ?, 1, 1, NULL, ?)`
    ).run(Date.parse(`${D}T20:00:00+08:00`), Date.parse(`${D}T20:00:01+08:00`))
    const c3 = []; const t3 = []
    const r3 = await dailySalesReport(ctx.db, { send: mk(c3, t3), day: D })
    expect(r3.pushed).toBe(false)
    expect(c3.length).toBe(0)
    expect(t3.length).toBe(0) // 未重发
  })
})

describe('S79-7 配置：默认值即生产值、可改、开关默认关', () => {
  it('S79-7: sales 默认值（chatId/baseToken/tableId）与 scheduler 键；可改；非法值 400', () => {
    const def = getSetting(ctx.db, 'sales')
    expect(def.chatId).toMatch(/^oc_/)
    expect(def.baseToken).toMatch(/^\w+$/)
    expect(def.tableId).toMatch(/^tbl/)

    setSetting(ctx.db, 'sales', { chatId: 'oc_new_group' })
    expect(getSetting(ctx.db, 'sales').chatId).toBe('oc_new_group')
    expect(getSetting(ctx.db, 'sales').baseToken).toBe(def.baseToken) // deepMerge：未提交键保留

    expect(() => setSetting(ctx.db, 'sales', { chatId: ' ' })).toThrow(/非空/)

    const sched = getSetting(ctx.db, 'scheduler')
    expect(sched.salesEnabled).toBe(false)
    expect(sched.salesReportEnabled).toBe(false)
    expect(sched.salesCron).toBe('*/30 * * * *')
    expect(dueTasks(sched, { salesExtraction: 0 }, Date.now())).not.toContain('salesExtraction')

    setSetting(ctx.db, 'scheduler', { salesEnabled: true, salesCron: '* * * * *' })
    expect(dueTasks(getSetting(ctx.db, 'scheduler'), { salesExtraction: 0 }, Date.now())).toContain('salesExtraction')
    expect(() => setSetting(ctx.db, 'scheduler', { salesCron: 'not-a-cron' })).toThrow()
  })
  it('S79-7: looksLikeReport 强信号词驱动兜底；裸「成交」不触发', () => {
    expect(looksLikeReport('出单了 客户王总')).toBe(true)
    expect(looksLikeReport('【销售成交报单】')).toBe(true)
    expect(looksLikeReport('这个月冲30万成交目标！')).toBe(false)
    expect(looksLikeReport('早上好')).toBe(false)
  })
})
