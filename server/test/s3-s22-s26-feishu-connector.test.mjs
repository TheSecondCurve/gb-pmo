// S3（消息拉取）/ S20（出站发送、群信息、机器人身份）/ S22（日历对账）/ S26（长连接自检）— 飞书连接器深度测试。
// 全部经 globalThis.fetch 注桩走真实请求构造路径（URL/方法/鉴权头/请求体 schema），不发真实网络。
// 出站请求体 schema 断言是 v0.21 的回归锚点（线上实测：stub 不校验请求形状，permissions 枚举变更 400 到线上才发现）。
import { describe, it, expect, vi } from 'vitest'
import {
  fetchMessages, testConnection, selfCheck, sendText, sendCard, patchText, getChat, getBotInfo,
  createCalendar, createEvent, patchEvent,
} from '../brain/connectors/feishu.js'

const CFG = { appId: 'cli_test', appSecret: 'sec_test' }

// selfCheck 动态 import 官方 SDK——mock 成可控假 WSClient（握手结果走回调，与 1.74 语义一致）
vi.mock('@larksuiteoapi/node-sdk', () => {
  const state = { behavior: 'ready' } // ready | error | hang
  class WSClient {
    constructor(opts) { this.opts = opts }
    start() {
      if (state.behavior === 'ready') setTimeout(() => this.opts.onReady?.(), 0)
      else if (state.behavior === 'error') setTimeout(() => this.opts.onError?.(new Error('handshake refused (99991679)')), 0)
      return new Promise(() => {}) // SDK 语义：start 不以 resolve/reject 报结果，结果走 onReady/onError
    }
    close() {}
  }
  class EventDispatcher {}
  return { default: { WSClient, EventDispatcher }, WSClient, EventDispatcher, __state: state }
})

const wsBehavior = async (b) => { (await import('@larksuiteoapi/node-sdk')).__state.behavior = b }

/** fetch 桩：按 URL 片段路由应答，记录调用（URL/方法/解析后的请求体）供 schema 断言。 */
function stubFetch(routes) {
  const calls = []
  const real = globalThis.fetch
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url)
    calls.push({ url: u, method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body ? JSON.parse(opts.body) : null })
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

const tokenOk = ['/auth/v3/tenant_access_token', { code: 0, tenant_access_token: 't-1' }]

describe('S3 消息拉取（fetchMessages / 文本归一）', () => {
  it('游标推进：cursor+1 为 start_time；分页 page_token 接续；末批 has_more=false 收束', async () => {
    const { calls, restore } = stubFetch([
      tokenOk,
      ['/im/v1/messages', (u) => {
        const q = new URL(u).searchParams
        if (!q.get('page_token')) {
          return { code: 0, data: { has_more: true, page_token: 'pt2', items: [
            { message_id: 'm1', msg_type: 'text', create_time: '5000', sender: { id: 'ou_1' }, body: { content: '{"text":"第一条"}' } },
          ] } }
        }
        return { code: 0, data: { has_more: false, items: [
          { message_id: 'm2', msg_type: 'text', create_time: '6000', sender: { id: 'ou_2' }, body: { content: '{"text":"第二条"}' } },
        ] } }
      }],
    ])
    try {
      const out = await fetchMessages(CFG, { groupKey: 'oc_g' }, '4000')
      expect(out.messages.map((m) => m.id)).toEqual(['m1', 'm2'])
      expect(out.nextCursor).toBe('6000')
      const first = new URL(calls.find((c) => c.url.includes('/im/v1/messages')).url).searchParams
      expect(first.get('start_time')).toBe('4001') // cursor+1
      expect(first.get('container_id')).toBe('oc_g')
      expect(first.get('container_id_type')).toBe('chat')
      expect(first.get('sort_type')).toBe('ByCreateTimeAsc')
      const second = new URL(calls.filter((c) => c.url.includes('/im/v1/messages'))[1].url).searchParams
      expect(second.get('page_token')).toBe('pt2')
      expect(calls[1].headers.authorization).toBe('Bearer t-1')
    } finally { restore() }
  })

  it('空窗口：无新消息时游标推进到本次窗口终点（不重复拉空窗口）；无 cursor 默认回看 7 天', async () => {
    const { calls, restore } = stubFetch([tokenOk, ['/im/v1/messages', { code: 0, data: { has_more: false, items: [] } }]])
    try {
      const before = Math.floor(Date.now() / 1000)
      const out = await fetchMessages(CFG, { groupKey: 'oc_g' }, null)
      expect(out.messages).toEqual([])
      expect(Math.abs(Number(out.nextCursor) - before)).toBeLessThan(10)
      const q = new URL(calls.find((c) => c.url.includes('/im/v1/messages')).url).searchParams
      expect(Math.abs(Number(q.get('start_time')) - (before - 7 * 86400))).toBeLessThan(10)
    } finally { restore() }
  })

  it('消息文本归一：text / post（多语言段落）/ interactive / 畸形 JSON 回退原文 / 无 body 空串；sender 缺失归空', async () => {
    const { restore } = stubFetch([
      tokenOk,
      ['/im/v1/messages', { code: 0, data: { has_more: false, items: [
        { message_id: 't1', msg_type: 'text', create_time: '5001', sender: { id: 'ou' }, body: { content: '{"text":"纯文本"}' } },
        { message_id: 'p1', msg_type: 'post', create_time: '5002', sender: { id: 'ou' }, body: { content: JSON.stringify({ zh_cn: { title: '标题', content: [[{ text: '段一' }], [{ text: '段' }, { text: '二' }]] }, en_us: { title: '', content: [[{ text: 'EN' }]] } }) } },
        { message_id: 'i1', msg_type: 'interactive', create_time: '5003', body: { content: JSON.stringify({ elements: [{ text: { text: '卡片文字' } }, { tag: 'hr' }] }) } },
        { message_id: 'b1', msg_type: 'text', create_time: '5004', sender: { id: 'ou' }, body: { content: '不是JSON' } },
        { message_id: 'n1', msg_type: 'text', create_time: '5005' },
      ] } }],
    ])
    try {
      const out = await fetchMessages(CFG, { groupKey: 'oc_g' }, '5000')
      const byId = Object.fromEntries(out.messages.map((m) => [m.id, m]))
      expect(byId.t1.text).toBe('纯文本')
      expect(byId.p1.text).toBe('标题 段一 段 二 EN') // 连接器按 run 粒度空格连接（与网关段落拍平是两套语义）
      expect(byId.i1.text).toBe('卡片文字 hr')
      expect(byId.b1.text).toBe('不是JSON')
      expect(byId.n1.text).toBe('')
      expect(byId.i1.speakerId).toBe('') // sender 缺失归空
    } finally { restore() }
  })

  it('上游失败：HTTP 非 2xx 与业务码非 0 都抛 502 并带飞书业务信息（S22-6 同构口径）', async () => {
    let restore = stubFetch([['/auth/v3/tenant_access_token', new Response('gateway down', { status: 502 })]]).restore
    try {
      await expect(fetchMessages(CFG, { groupKey: 'g' }, null)).rejects.toThrow('飞书 token HTTP 502')
    } finally { restore() }

    const s2 = stubFetch([tokenOk, ['/im/v1/messages', { code: 99991400, msg: 'chat not found' }]])
    try {
      await expect(fetchMessages(CFG, { groupKey: 'g' }, null)).rejects.toThrow('飞书消息失败(99991400): chat not found')
    } finally { s2.restore() }

    const s3 = stubFetch([tokenOk, ['/im/v1/messages', new Response('{}', { status: 500 })]])
    try {
      await expect(fetchMessages(CFG, { groupKey: 'g' }, null)).rejects.toThrow('飞书消息 HTTP 500')
    } finally { s3.restore() }
  })
})

describe('S26-4 连通性：testConnection 与长连接三段自检', () => {
  it('testConnection：缺凭证指引 / 成功 / token HTTP 失败 / 业务码失败', async () => {
    expect((await testConnection({})).ok).toBe(false)
    expect((await testConnection({})).reason).toContain('appId')

    let s = stubFetch([tokenOk])
    try { expect((await testConnection(CFG)).ok).toBe(true) } finally { s.restore() }

    s = stubFetch([['/auth/v3/tenant_access_token', new Response('x', { status: 503 })]])
    try {
      const r = await testConnection(CFG)
      expect(r.ok).toBe(false)
      expect(r.reason).toContain('503')
    } finally { s.restore() }

    s = stubFetch([['/auth/v3/tenant_access_token', { code: 10003, msg: 'invalid app_id' }]])
    try {
      const r = await testConnection(CFG)
      expect(r.ok).toBe(false)
      expect(r.reason).toContain('10003')
    } finally { s.restore() }
  })

  it('selfCheck：未配置第①段即失败不发外网；token 失败定位到①；握手失败定位到②；成功含③人工指引', async () => {
    const noCfg = await selfCheck({})
    expect(noCfg.ok).toBe(false)
    expect(noCfg.stages[0].stage).toBe('token')
    expect(noCfg.stages[0].reason).toContain('配置台')

    let s = stubFetch([['/auth/v3/tenant_access_token', { code: 10003, msg: 'bad id' }]])
    try {
      const r = await selfCheck(CFG)
      expect(r.ok).toBe(false)
      expect(r.stages.at(-1).stage).toBe('token')
      expect(r.stages.at(-1).reason).toContain('10003')
    } finally { s.restore() }

    await wsBehavior('error')
    s = stubFetch([tokenOk])
    try {
      const r = await selfCheck(CFG)
      expect(r.ok).toBe(false)
      expect(r.stages.at(-1).stage).toBe('ws')
      expect(r.stages.at(-1).reason).toContain('长连接握手失败')
      expect(r.stages.at(-1).reason).toContain('99991679')
    } finally { s.restore() }

    await wsBehavior('hang')
    s = stubFetch([tokenOk])
    try {
      const r = await selfCheck(CFG, { waitMs: 30 })
      expect(r.ok).toBe(false)
      expect(r.stages.at(-1).reason).toContain('握手超时')
    } finally { s.restore() }

    await wsBehavior('ready')
    s = stubFetch([tokenOk])
    try {
      const r = await selfCheck(CFG)
      expect(r.ok).toBe(true)
      expect(r.stages.map((x) => x.stage)).toEqual(['token', 'ws'])
      expect(r.stages[1].note).toContain('人工验证')
    } finally { s.restore() }
  })
})

describe('S20 出站发送与群/机器人信息——请求体 schema 断言 + 错误面', () => {
  it('postMessage 请求体：receive_id/msg_type/JSON 字符串 content；HTTP 与业务码失败带信息', async () => {
    const s = stubFetch([
      tokenOk,
      ['/im/v1/messages', { code: 0, data: { message_id: 'om_x' } }],
    ])
    try {
      await sendText(CFG, 'oc_1', '你好')
      const call = s.calls.find((c) => c.url.includes('receive_id_type=chat_id'))
      expect(call.body.receive_id).toBe('oc_1')
      expect(call.body.msg_type).toBe('text')
      expect(typeof call.body.content).toBe('string') // content 是 JSON 字符串而非对象
      expect(JSON.parse(call.body.content)).toEqual({ text: '你好' })
      expect(call.headers['content-type']).toBe('application/json')
      expect(call.headers.authorization).toBe('Bearer t-1')
    } finally { s.restore() }

    let s2 = stubFetch([tokenOk, ['/im/v1/messages', new Response('x', { status: 429 })]])
    try {
      await expect(sendText(CFG, 'oc_1', 'x')).rejects.toThrow('飞书发送 HTTP 429')
    } finally { s2.restore() }

    s2 = stubFetch([tokenOk, ['/im/v1/messages', { code: 230001, msg: 'bot not in chat' }]])
    try {
      await expect(sendCard(CFG, 'oc_1', {})).rejects.toThrow('飞书发送失败(230001): bot not in chat')
    } finally { s2.restore() }

    // data.message_id 缺失 → null 兜底（不炸调用方）
    s2 = stubFetch([tokenOk, ['/im/v1/messages', { code: 0, data: {} }]])
    try {
      expect((await sendText(CFG, 'oc_1', 'x')).messageId).toBeNull()
    } finally { s2.restore() }
  })

  it('patchText 错误面：HTTP 非 2xx / 业务码非 0（调用方据此降级另发新消息，S20-19）', async () => {
    let s = stubFetch([tokenOk, ['/im/v1/messages/om_1', new Response('x', { status: 403 })]])
    try {
      await expect(patchText(CFG, 'om_1', 'x')).rejects.toThrow('飞书编辑消息 HTTP 403')
    } finally { s.restore() }
    s = stubFetch([tokenOk, ['/im/v1/messages/om_1', { code: 230027, msg: 'message not editable' }]])
    try {
      await expect(patchText(CFG, 'om_1', 'x')).rejects.toThrow('飞书编辑消息失败(230027): message not editable')
    } finally { s.restore() }
  })

  it('getChat：返回 data（external 判定源 S20-7）；失败带业务码', async () => {
    let s = stubFetch([tokenOk, ['/im/v1/chats/oc_1', { code: 0, data: { external: false, name: '项目群' } }]])
    try {
      const chat = await getChat(CFG, 'oc_1')
      expect(chat.external).toBe(false)
      expect(chat.name).toBe('项目群')
      expect(s.calls[1].headers.authorization).toBe('Bearer t-1')
    } finally { s.restore() }

    s = stubFetch([tokenOk, ['/im/v1/chats/oc_1', { code: 99991400, msg: 'chat not found' }]])
    try {
      await expect(getChat(CFG, 'oc_1')).rejects.toThrow('飞书群信息失败(99991400)')
    } finally { s.restore() }

    s = stubFetch([tokenOk, ['/im/v1/chats/oc_1', new Response('x', { status: 500 })]])
    try {
      await expect(getChat(CFG, 'oc_1')).rejects.toThrow('飞书群信息 HTTP 500')
    } finally { s.restore() }
  })

  it('getBotInfo：bot 两种落位形态（bot / data.bot）与缺失兜底 null；失败带业务码（S20-16 降级依据）', async () => {
    let s = stubFetch([tokenOk, ['/bot/v3/info', { code: 0, bot: { open_id: 'ou_bot', app_name: '项目大脑' } }]])
    try {
      expect(await getBotInfo(CFG)).toEqual({ openId: 'ou_bot', appName: '项目大脑' })
    } finally { s.restore() }

    s = stubFetch([tokenOk, ['/bot/v3/info', { code: 0, data: { bot: { open_id: 'ou_bot2' } } }]])
    try {
      expect((await getBotInfo(CFG)).openId).toBe('ou_bot2')
    } finally { s.restore() }

    s = stubFetch([tokenOk, ['/bot/v3/info', { code: 0 }]])
    try {
      expect(await getBotInfo(CFG)).toEqual({ openId: null, appName: null })
    } finally { s.restore() }

    s = stubFetch([tokenOk, ['/bot/v3/info', { code: 10003, msg: 'invalid' }]])
    try {
      await expect(getBotInfo(CFG)).rejects.toThrow('飞书机器人信息失败(10003)')
    } finally { s.restore() }
  })
})

describe('S22 日历出站——schema 断言（v0.21 回归锚点）与上游失败回显（S22-6）', () => {
  it('createCalendar 发枚举字符串 permissions=public（旧对象格式被飞书 400 的线上根因）', async () => {
    const s = stubFetch([tokenOk, ['/calendar/v4/calendars', { code: 0, data: { calendar: { calendar_id: 'cal_1' } } }]])
    try {
      const r = await createCalendar(CFG, { summary: '项目日历', description: 'desc' })
      expect(r.calendarId).toBe('cal_1')
      const call = s.calls.find((c) => c.url.includes('/calendar/v4/calendars'))
      expect(call.method).toBe('POST')
      expect(call.body.permissions).toBe('public') // 枚举字符串，不是 share_tenant_permission 对象
      expect(typeof call.body.permissions).toBe('string')
      expect(call.body.summary).toBe('项目日历')
    } finally { s.restore() }
  })

  it('createEvent/patchEvent 全日事件 schema：start/end_time={date,timestamp:""} 闭区间、need_notification=false', async () => {
    const s = stubFetch([
      tokenOk,
      ['/events', { code: 0, data: { event: { event_id: 'ev_1' } } }],
    ])
    try {
      const content = { summary: '「客户A」进行中', description: 'd', startDay: '2026-10-01', endDay: '2026-12-31' }
      const r = await createEvent(CFG, 'cal_1', content)
      expect(r.eventId).toBe('ev_1')
      const create = s.calls.find((c) => c.url.endsWith('/events') && c.method === 'POST')
      expect(create.url).toContain('/calendar/v4/calendars/cal_1/events')
      expect(create.body.start_time).toEqual({ date: '2026-10-01', timestamp: '' })
      expect(create.body.end_time).toEqual({ date: '2026-12-31', timestamp: '' })
      expect(create.body.need_notification).toBe(false)

      const pr = await patchEvent(CFG, 'cal_1', 'ev_1', { ...content, summary: '【已结项】「客户A」' })
      expect(pr.eventId).toBe('ev_1')
      const patch = s.calls.find((c) => c.url.includes('/events/ev_1'))
      expect(patch.method).toBe('PATCH')
      expect(patch.body.summary).toContain('已结项')
      expect(patch.body.need_notification).toBeUndefined() // patch 不带通知字段
    } finally { s.restore() }
  })

  it('callApi 上游失败：非 2xx 读出响应体业务码与 msg（不得丢弃）；非 JSON 体仅回状态码；2xx 业务码非 0 同带', async () => {
    // v0.21 根因形态：400 + {code:99992402, msg:'field validation failed'}
    let s = stubFetch([tokenOk, ['/calendar/v4/calendars', new Response(JSON.stringify({ code: 99992402, msg: 'field validation failed' }), { status: 400 })]])
    try {
      await expect(createCalendar(CFG, { summary: 'x' })).rejects.toThrow('飞书日历 HTTP 400(99992402): field validation failed')
    } finally { s.restore() }

    s = stubFetch([tokenOk, ['/calendar/v4/calendars', new Response('Bad Request', { status: 400 })]])
    try {
      await expect(createCalendar(CFG, { summary: 'x' })).rejects.toThrow('飞书日历 HTTP 400')
    } finally { s.restore() }

    s = stubFetch([tokenOk, ['/calendar/v4/calendars', { code: 99991679, msg: 'no permission' }]])
    try {
      await expect(createCalendar(CFG, { summary: 'x' })).rejects.toThrow('飞书日历失败(99991679): no permission')
    } finally { s.restore() }
  })

  it('calendar_id / event_id 缺失兜底 null（调用方按空值计入 errors，不炸对账循环）', async () => {
    const s = stubFetch([tokenOk, ['/calendar/v4/calendars', { code: 0, data: {} }]])
    try {
      expect((await createCalendar(CFG, { summary: 'x' })).calendarId).toBeNull()
      expect((await createEvent(CFG, 'cal_1', { summary: 's', startDay: '2026-10-01', endDay: '2026-10-02' })).eventId).toBeNull()
    } finally { s.restore() }
  })
})
