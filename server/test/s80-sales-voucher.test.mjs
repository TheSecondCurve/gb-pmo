// S80（v0.94.1，K80）— 报单凭证截图归档：图文识别（imageKeys）/ 归属算法（±10 分钟窗、跨人
// 不抢、多图、无主静默、重放幂等、两遍处理）/ 附件同步（create 携带、PATCH 追加、token 对位
// 幂等、失败降级）/ 口径边界（不上回执不进汇总）。fetch 注桩走真实请求构造路径（S78/S79 同款）。
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupApp } from './helpers.mjs'
import { setSetting } from '../engine/settings.js'
import { extractImageKeys, fetchMessages } from '../brain/connectors/feishu.js'
import { attachVoucher, getVouchers, insertSalesRecord, recordSalesMessage } from '../engine/sales.js'
import { toBitableFields, syncPendingToBitable, syncVoucherBackfill } from '../brain/salesSync.js'
import { runSalesExtraction } from '../brain/salesExtract.js'

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

const TOKEN_OK = ['/auth/v3/tenant_access_token', { code: 0, tenant_access_token: 't-s80' }]
const msg = (id, text, sec, extra = {}) => ({
  message_id: id, msg_type: 'text', create_time: String(sec), sender: { id: 'ou_seller_1' },
  body: { content: JSON.stringify({ text }) }, ...extra,
})
const imgMsg = (id, key, sec, sender = 'ou_seller_1') => ({
  message_id: id, msg_type: 'image', create_time: String(sec), sender: { id: sender },
  body: { content: JSON.stringify({ image_key: key }) },
})
const FULL_REPORT = `【销售成交报单】
成交日期：2026年11月18日
成交金额：¥1,280
成交产品：365连麦
客户昵称/标识：测试客户
订单号：S80ORDER0001`

let ctx
beforeAll(async () => {
  ctx = await setupApp()
  setSetting(ctx.db, 'im.feishu', { appId: 'cli_s80', appSecret: 'sec_s80' })
})
afterAll(() => ctx?.db.close())

describe('S80-1 图文识别（extractImageKeys）', () => {
  it('S80-1: image 消息提 image_key；post 富文本内嵌 img 元素都提；纯文本为空数组', () => {
    expect(extractImageKeys(imgMsg('om_i1', 'img_v2_abc', 1))).toEqual(['img_v2_abc'])
    const post = {
      msg_type: 'post',
      body: { content: JSON.stringify({ zh_cn: { title: '报单', content: [
        [{ tag: 'text', text: '成交 1280' }],
        [{ tag: 'img', image_key: 'img_v2_p1' }, { tag: 'img', image_key: 'img_v2_p2' }],
      ] } }) },
    }
    expect(extractImageKeys(post)).toEqual(['img_v2_p1', 'img_v2_p2'])
    expect(extractImageKeys(msg('om_t', '纯文本', 1))).toEqual([])
    expect(extractImageKeys({ msg_type: 'image', body: { content: 'not-json' } })).toEqual([])
  })
  it('S80-1: fetchMessages 消息对象带 imageKeys（连接器集成）', async () => {
    const s = stubFetch([TOKEN_OK, ['/im/v1/messages', () => ({ code: 0, data: { has_more: false, items: [
      msg('om_t1', '文本', 20001), imgMsg('om_i1', 'img_v2_x', 20002),
    ] } })]])
    try {
      const { messages } = await fetchMessages({ appId: 'a', appSecret: 'b' }, { groupKey: 'oc_x' }, 20000)
      expect(messages.find((m) => m.id === 'om_t1').imageKeys).toEqual([])
      expect(messages.find((m) => m.id === 'om_i1').imageKeys).toEqual(['img_v2_x'])
    } finally { s.restore() }
  })
})

describe('S80-2 归属算法（attachVoucher + 两遍抽取）', () => {
  it('S80-2: 文先图后同轮归属；跨发言人不抢；无主图静默；多图全挂；重放幂等；图先文后可关联', async () => {
    const items = [
      imgMsg('om_orphan', 'img_v2_orphan', 30100, 'ou_seller_2'), // 无主（其他发言人/窗口内无其报单）
      msg('om_r1', FULL_REPORT, 30200),
      imgMsg('om_v1', 'img_v2_k1', 30230), // 文先图后 30 秒 → 挂 om_r1
      imgMsg('om_v2', 'img_v2_k2', 30250, 'ou_seller_2'), // 跨发言人 → 不挂
      imgMsg('om_v3', 'img_v2_k3', 30300), // 同发言人第二张 → 也挂
    ]
    const s = stubFetch([TOKEN_OK, ['/im/v1/messages', () => ({ code: 0, data: { has_more: false, items } })]])
    try {
      const sent = []
      const r = await runSalesExtraction(ctx.db, { send: (t) => sent.push(t) })
      expect(r.recorded).toBe(1)
      expect(r.voucherAttached).toBe(2) // v1 + v3（orphan 与跨发言人的 v2 不挂）
      const rec = ctx.db.prepare("SELECT id, vouchers FROM sales_records WHERE order_no = 'S80ORDER0001'").get()
      const vouchers = JSON.parse(rec.vouchers)
      expect(vouchers.map((v) => v.imageKey).sort()).toEqual(['img_v2_k1', 'img_v2_k3'].sort())
      // 重放：同批消息再跑一轮，归属幂等不重复
      const r2 = await runSalesExtraction(ctx.db, { send: () => {} })
      expect(r2.recorded).toBe(0)
      expect(JSON.parse(ctx.db.prepare('SELECT vouchers FROM sales_records WHERE id = ?').get(rec.id).vouchers)).toHaveLength(2)
      // 图先文后：新报单前 20 秒的图（同发言人）也能挂
      items.length = 0
      items.push(imgMsg('om_pre', 'img_v2_pre', 30400), msg('om_r2', FULL_REPORT.replace('S80ORDER0001', 'S80ORDER0002'), 30420))
      const r3 = await runSalesExtraction(ctx.db, { send: () => {} })
      expect(r3.recorded).toBe(1)
      const rec2 = ctx.db.prepare("SELECT vouchers FROM sales_records WHERE order_no = 'S80ORDER0002'").get()
      expect(JSON.parse(rec2.vouchers)).toEqual([{ msgId: 'om_pre', imageKey: 'img_v2_pre' }])
    } finally { s.restore() }
  })
  it('S80-2: attachVoucher 纯函数——±10 分钟窗口边界与最近优先', () => {
    const db = ctx.db
    db.prepare('DELETE FROM sales_records').run(); db.prepare('DELETE FROM sales_messages').run()
    // 两笔已落库报单：30100 与 30700（同一发言人）；id 用引擎返回值（不假设自增序号）
    const ids = {}
    for (const [sec, order] of [[30100, 'W1'], [30700, 'W2']]) {
      const mid = `om_w_${order}`
      recordSalesMessage(db, { messageId: mid, chatId: 'oc_x', speakerId: 'ou_w', text: 'r', ts: sec * 1000, status: 'recorded', detail: 'x' })
      ids[order] = insertSalesRecord(db, { messageId: mid, orderNo: order, dealDay: '2026-11-18', dealTs: 0, amount: 1, customerNick: 'w' })
    }
    expect(attachVoucher(db, { speakerId: 'ou_w', ts: 30300 * 1000, messageId: 'om_img_a', imageKey: 'kA' })).toBe(true) // 距 W1 200s < W2 400s → 挂 W1
    expect(attachVoucher(db, { speakerId: 'ou_w', ts: 30500 * 1000, messageId: 'om_img_b', imageKey: 'kB' })).toBe(true) // 距 W2 200s → 挂 W2
    expect(attachVoucher(db, { speakerId: 'ou_w', ts: 31301 * 1000, messageId: 'om_img_c', imageKey: 'kC' })).toBe(false) // 距最近报单 601s > 10 分钟 → 无主（600s 恰含端点属窗口内）
    expect(getVouchers(db, ids.W1)).toEqual([{ msgId: 'om_img_a', imageKey: 'kA' }])
    expect(getVouchers(db, ids.W2)).toEqual([{ msgId: 'om_img_b', imageKey: 'kB' }])
  })
})

describe('S80-3 附件同步（create 携带 / PATCH 追加 / token 幂等 / 降级）', () => {
  it('S80-3: 未同步行 create 携带附件；上传失败跳过不阻塞行同步；backfill 对已同步行 PATCH 合并追加', async () => {
    const db = ctx.db
    db.prepare('DELETE FROM sales_records').run(); db.prepare('DELETE FROM sales_messages').run()
    // 行 A：带两张图（一张上传会失败）；行 B：无图
    recordSalesMessage(db, { messageId: 'om_a', chatId: 'oc_x', speakerId: 'ou_a', text: 'r', ts: 1, status: 'recorded', detail: 'x' })
    const a = insertSalesRecord(db, { messageId: 'om_a', orderNo: 'VA', dealDay: '2026-11-18', dealTs: 0, amount: 9, customerNick: 'a', vouchers: JSON.stringify([{ msgId: 'om_img1', imageKey: 'k1' }, { msgId: 'om_img2', imageKey: 'k2' }]) })
    void a
    recordSalesMessage(db, { messageId: 'om_b', chatId: 'oc_x', speakerId: 'ou_b', text: 'r', ts: 2, status: 'recorded', detail: 'x' })
    insertSalesRecord(db, { messageId: 'om_b', orderNo: 'VB', dealDay: '2026-11-18', dealTs: 0, amount: 8, customerNick: 'b' })

    const bodies = []
    const s = stubFetch([
      TOKEN_OK,
      ['/im/v1/messages/', (u) => {
        if (u.includes('/resources/')) return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/png' } })
        return { code: 0, data: {} }
      }],
      ['/drive/v1/medias/upload_all', (u, opts) => {
        const fd = opts.body
        const name = fd?.get?.('file_name') || ''
        if (name.includes('img2')) return new Response(JSON.stringify({ code: -1, msg: 'upload boom' }), { status: 200 }) // 第二张失败
        return { code: 0, data: { file_token: 'ftok_' + name } }
      }],
      ['/bitable/v1/apps/', (u, opts) => {
        if (opts.method === 'POST') { bodies.push({ kind: 'create', body: JSON.parse(opts.body) }); return { code: 0, data: { records: [{ record: { record_id: 'recVA' } }, { record: { record_id: 'recVB' } }] } } }
        bodies.push({ kind: 'patch', url: u, body: JSON.parse(opts.body) })
        return { code: 0, data: { record: {} } }
      }],
    ])
    try {
      const r1 = await syncPendingToBitable(db)
      expect(r1.synced).toBe(2) // A 行第二张图上传失败不阻塞——整行照常同步
      const createA = bodies.find((b) => b.kind === 'create').body.records[0].fields
      expect(createA.成交凭证).toEqual([{ file_token: 'ftok_凭证-om_img1.png' }]) // 只有成功的那张；失败位空缺
      expect(bodies.find((b) => b.kind === 'create').body.records[1].fields.成交凭证).toBeUndefined() // 无图行不带字段

      // 重跑 create 不再发生（行已同步）；但 A 行 token 空位 → backfill：上传补齐（本轮 stub img2 仍失败 → 不 PATCH）
      const rb = await syncVoucherBackfill(db)
      expect(rb.attempted).toBe(1)
      expect(rb.patched).toBe(0) // 第二张仍失败 → 不动行
    } finally { s.restore() }

    // 恢复上传（img2 成功）→ backfill PATCH 合并新旧 token
    const bodies2 = []
    const s2 = stubFetch([
      TOKEN_OK,
      ['/im/v1/messages/', (u) => {
        if (u.includes('/resources/')) return new Response(new Uint8Array([9]), { status: 200, headers: { 'content-type': 'image/png' } })
        return { code: 0, data: {} }
      }],
      ['/drive/v1/medias/upload_all', (u, opts) => ({ code: 0, data: { file_token: 'ftok_凭证-' + (opts.body?.get?.('file_name') || '') } })],
      ['/bitable/v1/apps/', (u, opts) => { bodies2.push({ url: u, method: opts.method, body: JSON.parse(opts.body) }); return { code: 0, data: { record: {} } } }],
    ])
    try {
      const rb2 = await syncVoucherBackfill(db)
      expect(rb2.patched).toBe(1)
      const patch = bodies2.find((b) => b.method === 'PUT')
      expect(patch.url).toContain('/records/recVA')
      expect(patch.body.fields.成交凭证.map((f) => f.file_token).sort()).toEqual(['ftok_凭证-om_img1.png', 'ftok_凭证-凭证-om_img2.png'].sort()) // 新旧合并整体写入（stub 二次拼接前缀）
      // 再跑一轮：token 齐了 → 无待补行，零 PATCH
      const rb3 = await syncVoucherBackfill(db)
      expect(rb3.attempted).toBe(0)
    } finally { s2.restore() }
  })
  it('S80-4: toBitableFields 凭证映射——空 token 过滤；凭证不上回执不进汇总（S79 口径回归）', () => {
    const f = toBitableFields({ messageId: 'm1', dealTs: 1, amount: 2, customerNick: 'c' }, [null, 'ft1'])
    expect(f.成交凭证).toEqual([{ file_token: 'ft1' }])
    expect(toBitableFields({ messageId: 'm1', dealTs: 1, amount: 2, customerNick: 'c' }).成交凭证).toBeUndefined()
  })
})
