// S78（v0.92，K78）— 引用回复上下文透传：连接器回查（缓存/降级/卡片拍平）→ 机器人事件面
// （LLM 上下文/斜杠隔离/审计留痕/im_buffer 缓冲列）→ 抽取面（噪音口径/并入 prompt/归因不变）
// → recent_chat/minutes 回读行格式。连接器断言经 globalThis.fetch 注桩走真实请求构造路径（K7 同款）。
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupApp } from './helpers.mjs'
import { BOT_SECRET, scriptedLlm, makeMsgFactory, mkProject, botRow } from './bot-kit.mjs'
import { handleBotEvent } from '../brain/bot/command.js'
import { runRecentChatTool } from '../brain/bot/tools.js'
import { ingestMessages, drainBuffer } from '../brain/extract.js'
import { createProject } from '../engine/projects.js'
import { upsertChannel } from '../engine/tasks.js'
import { fetchMessages, getMessage, resolveQuote, clearQuoteCache } from '../brain/connectors/feishu.js'

const CFG = { appId: 'cli_s78', appSecret: 'sec_s78' }

/** fetch 桩：按 URL 片段路由应答，记录调用（与 s3-s22-s26 连接器测试同款）。 */
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

const tokenOk = ['/auth/v3/tenant_access_token', { code: 0, tenant_access_token: 't-s78' }]
const single = (id, item) => [`/im/v1/messages/${id}`, { code: 0, data: { items: [item] } }]
const listRoute = (items) => ['/im/v1/messages?', { code: 0, data: { has_more: false, items } }]

let ctx
const { p2p, group } = makeMsgFactory('om_s78')

beforeAll(async () => {
  ctx = await setupApp()
})
afterAll(() => ctx?.db.close())

describe('S78-1 连接器：引用回查（fetchMessages 附 parentId/quoteText/quoteSpeakerId）', () => {
  it('S78-1: 带 parent_id 的消息回查被引用原文（data.items[0]）；无 parent 零回查；同 parent 进程内缓存零重复回查', async () => {
    clearQuoteCache()
    const quoted = { message_id: 'om_qt1', msg_type: 'text', sender: { id: 'fs_li' }, body: { content: '{"text":"需求确认已交付给客户"}' } }
    const s = stubFetch([
      tokenOk,
      single('om_qt1', quoted),
      listRoute([
        { message_id: 'm_plain', msg_type: 'text', create_time: '7001', sender: { id: 'fs_zhang' }, body: { content: '{"text":"普通消息"}' } },
        { message_id: 'm_q1', msg_type: 'text', create_time: '7002', sender: { id: 'fs_zhang' }, parent_id: 'om_qt1', body: { content: '{"text":"这个算完成了"}' } },
        { message_id: 'm_q2', msg_type: 'text', create_time: '7003', sender: { id: 'fs_zhang' }, parent_id: 'om_qt1', body: { content: '{"text":"按这条登记风险"}' } },
      ]),
    ])
    try {
      const out = await fetchMessages(CFG, { groupKey: 'oc_s78' }, '7000')
      const byId = Object.fromEntries(out.messages.map((m) => [m.id, m]))
      expect(byId.m_plain.parentId).toBeNull()
      expect(byId.m_plain.quoteText).toBeNull()
      expect(byId.m_q1.parentId).toBe('om_qt1')
      expect(byId.m_q1.quoteText).toBe('需求确认已交付给客户')
      expect(byId.m_q1.quoteSpeakerId).toBe('fs_li')
      expect(byId.m_q2.quoteText).toBe('需求确认已交付给客户') // 同 parent 缓存命中
      const quoteCalls = s.calls.filter((c) => c.url.includes('/im/v1/messages/om_qt1'))
      expect(quoteCalls).toHaveLength(1) // 三条消息只回查一次；且是 GET
      expect(quoteCalls[0].method).toBe('GET')
      expect(quoteCalls[0].headers.authorization).toBe('Bearer t-s78')
      // 第二轮拉取再遇同 parent → 仍零新增回查
      await fetchMessages(CFG, { groupKey: 'oc_s78' }, '7000')
      expect(s.calls.filter((c) => c.url.includes('/im/v1/messages/om_qt1'))).toHaveLength(1)
    } finally { s.restore() }
  })

  it('S78-1: 回查失败（业务码）降级 quoteText=null 不阻断拉取与游标推进；getMessage 错误面（HTTP/业务码）；引用为图片给 [图片] 占位', async () => {
    clearQuoteCache()
    let s = stubFetch([
      tokenOk,
      ['/im/v1/messages/om_dead', { code: 230002, msg: 'bot not in chat' }],
      listRoute([
        { message_id: 'm_fail', msg_type: 'text', create_time: '7101', sender: { id: 'fs_zhang' }, parent_id: 'om_dead', body: { content: '{"text":"这个完成了"}' } },
      ]),
    ])
    try {
      const out = await fetchMessages(CFG, { groupKey: 'oc_s78' }, '7100')
      expect(out.messages[0].quoteText).toBeNull() // 降级无引用
      expect(out.messages[0].text).toBe('这个完成了') // 正文不受影响
      expect(out.nextCursor).toBe('7101') // 游标照常推进
    } finally { s.restore() }

    s = stubFetch([tokenOk, ['/im/v1/messages/om_x', new Response('x', { status: 500 })]])
    try { await expect(getMessage(CFG, 'om_x')).rejects.toThrow('飞书单条消息 HTTP 500') } finally { s.restore() }
    s = stubFetch([tokenOk, ['/im/v1/messages/om_x', { code: 99991679, msg: 'no permission' }]])
    try { await expect(getMessage(CFG, 'om_x')).rejects.toThrow('飞书单条消息失败(99991679): no permission') } finally { s.restore() }

    clearQuoteCache()
    s = stubFetch([
      tokenOk,
      single('om_img', { message_id: 'om_img', msg_type: 'image', sender: { id: 'fs_li' }, body: { content: '{"image_key":"img_v3_x"}' } }),
    ])
    try {
      const q = await resolveQuote(CFG, 'om_img')
      expect(q.text).toBe('[图片]') // 非文本引用给占位，不漏原始 JSON
    } finally { s.restore() }
  })
})

describe('S78-5 卡片引用可读（interactive 拍平补 lark_md content）', () => {
  it('S78-5: 被引用消息为机器人卡片时读出 div 文本（lark_md content 与旧 plain text 字段都认），不再只剩 tag 名', async () => {
    clearQuoteCache()
    const s = stubFetch([
      tokenOk,
      single('om_card_md', { message_id: 'om_card_md', msg_type: 'interactive', sender: { id: 'ou_bot', sender_type: 'app' }, body: { content: JSON.stringify({ elements: [
        { tag: 'div', text: { tag: 'lark_md', content: '任务 #12 需求确认：待验收' } },
        { tag: 'action' },
      ] }) } }),
      single('om_card_old', { message_id: 'om_card_old', msg_type: 'interactive', sender: { id: 'ou_bot' }, body: { content: JSON.stringify({ elements: [{ text: { text: '旧卡片正文' } }] }) } }),
    ])
    try {
      expect((await resolveQuote(CFG, 'om_card_md')).text).toContain('任务 #12 需求确认：待验收')
      expect((await resolveQuote(CFG, 'om_card_old')).text).toContain('旧卡片正文')
    } finally { s.restore() }
  })
})

describe('S78-2 机器人事件面：quote 信封 → LLM 上下文 / 审计 / 缓冲', () => {
  it('S78-2: quote 并入 LLM 用户消息（发言人映射名字，未映射省略）；斜杠命令解析仍用纯正文；detail 留痕且 raw_text 纯正文', async () => {
    await mkProject(ctx, '引用项目A', ctx.members.lead.id)
    const { llm, calls } = scriptedLlm(JSON.stringify({ action: 'reply', text: '已把任务标记完成。' }))
    const rec = recorder0()
    const quote = { messageId: 'om_q77', speakerId: 'fs_li', text: '#12 需求确认任务卡片：周五前交付' }
    const evt = { ...p2p('fs_zhang', '这个算完成了'), quote }
    const out = await handleBotEvent(ctx.db, evt, { llm, send: rec.send, secret: BOT_SECRET })
    expect(out.result).toBe('replied')
    // LLM 用户消息 = 纯正文 + 单行【引用 发言人】原文（fs_li → 李四）
    expect(calls[0][1].content).toBe('这个算完成了【引用 李四】#12 需求确认任务卡片：周五前交付')
    // 审计：raw_text 纯正文；detail 留痕 quoteText/quoteMessageId
    const row = botRow(ctx, evt.messageId)
    expect(row.raw_text).toBe('这个算完成了')
    const detail = JSON.parse(row.detail)
    expect(detail.quoteText).toBe('#12 需求确认任务卡片：周五前交付')
    expect(detail.quoteMessageId).toBe('om_q77')

    // 未映射发言人：省略名字，仍带引用原文（多轮历史注入后本轮用户消息在末位）
    const { llm: llm2, calls: calls2 } = scriptedLlm(JSON.stringify({ action: 'reply', text: '好的' }))
    await handleBotEvent(ctx.db, { ...p2p('fs_zhang', '按这条登记风险'), quote: { messageId: 'om_q78', speakerId: 'fs_unknown', text: '客户要求周五前上线' } }, { llm: llm2, send: recorder0().send, secret: BOT_SECRET })
    expect(calls2[0].at(-1).content).toBe('按这条登记风险【引用】客户要求周五前上线')

    // 斜杠命令：零 LLM、回执不含引用污染（/my 走确定性出口）
    const { llm: llm3, calls: calls3 } = scriptedLlm()
    const rec3 = recorder0()
    const out3 = await handleBotEvent(ctx.db, { ...p2p('fs_zhang', '/my'), quote }, { llm: llm3, send: rec3.send, secret: BOT_SECRET })
    expect(out3.result).toBe('replied')
    expect(calls3).toHaveLength(0)
    expect(JSON.stringify(rec3.sent[0])).not.toContain('【引用】') // /my 走 post 富文本，整个载荷都不带引用污染
  })

  it('S78-2: 未@群消息落 im_buffer 带 quote_text；排干抽取与 API 路径同口径（引用并入、归因发言人）', async () => {
    const p = createProject(ctx.db, { name: '引用项目B', typeCode: 'lianmai_365', leadMemberId: ctx.members.lead.id }, ctx.members.admin.id)
    upsertChannel(ctx.db, { platform: 'feishu', groupKey: 'oc_qbuf', channelType: 'dedicated', projectId: p.id })
    const { send } = recorder0()
    const evt = group('fs_zhang', 'oc_qbuf', '这个完成了', {
      mentioned: false, quote: { messageId: 'om_qb1', speakerId: 'fs_li', text: '#3 上线检查清单' },
    })
    const out = await handleBotEvent(ctx.db, evt, { send, secret: BOT_SECRET })
    expect(out.result).toBe('refused_not_mentioned')
    const buf = ctx.db.prepare('SELECT * FROM im_buffer WHERE message_id = ?').get(evt.messageId)
    expect(buf.quote_text).toBe('#3 上线检查清单') // migration 0040 新列

    // 排干：抽取 prompt 含并入后的引用文本；事件归因仍归当前发言人（fs_zhang→张三）
    const { llm, calls } = scriptedLlm(JSON.stringify({ events: [{ nature: 'record', eventType: 'progress', summary: '上线检查完成', confidence: 0.9 }] }))
    const stats = await drainBuffer(ctx.db, { platform: 'feishu', groupKey: 'oc_qbuf', channelType: 'dedicated', projectId: p.id }, { llm })
    expect(stats.events).toBeGreaterThanOrEqual(1)
    expect(calls[0][1].content).toContain('这个完成了【引用 李四】#3 上线检查清单')
    const ev = ctx.db.prepare('SELECT * FROM project_events WHERE source_ref = ?').get(evt.messageId)
    expect(ev.speaker_member_id).toBe(ctx.members.lead.id) // 归因=回复人张三，而非被引用者李四
    expect(ev.raw_snapshot).toContain('【引用 李四】#3 上线检查清单') // 原文快照含引用段
  })
})

describe('S78-3 抽取面：噪音口径 / 并入 prompt / 未分拣池 / 归因', () => {
  it('S78-3: 噪音预过滤按原文本判定（纯应酬带引用仍跳过）；带引用消息并入分批抽取 prompt；系统提示含引用语义', async () => {
    const p = createProject(ctx.db, { name: '引用项目C', typeCode: 'lianmai_365', leadMemberId: ctx.members.lead.id }, ctx.members.admin.id)
    const { llm, calls } = scriptedLlm(JSON.stringify({ events: [{ nature: 'record', eventType: 'progress', summary: '联调完成', confidence: 0.9 }] }))
    const stats = await ingestMessages(ctx.db, { platform: 'feishu', groupKey: 'oc_qc', channelType: 'dedicated', projectId: p.id }, [
      { id: 'om_noise', speakerId: 'fs_zhang', text: '好的', quoteText: '很长很长的被引用原文，不应把应酬短句从噪音里救活', ts: Date.now() },
      { id: 'om_quote', speakerId: 'fs_zhang', text: '这个完成了', quoteSpeakerId: 'fs_li', quoteText: '#5 接口联调', ts: Date.now() },
    ], { llm })
    expect(stats.noiseSkipped).toBe(1) // 「好的」仍按噪音跳过——不因引用进 LLM
    expect(calls).toHaveLength(1)
    expect(calls[0][0].content).toContain('【引用') // 系统提示说明引用段语义（上下文非新述）
    expect(calls[0][1].content).toContain('张三: 这个完成了【引用 李四】#5 接口联调')
  })

  it('S78-3: 通用群低置信进未分拣池，content 含并入后的引用文本（归挂复核可见上下文）', async () => {
    const routingLlm = { name: 'fake', complete: async () => JSON.stringify({ projectId: null, confidence: 0 }) }
    const stats = await ingestMessages(ctx.db, { platform: 'feishu', groupKey: 'oc_qg', channelType: 'general' }, [
      { id: 'om_gen', speakerId: 'fs_zhang', text: '就按这个方案办', quoteSpeakerId: 'fs_li', quoteText: '二期改用混合部署', ts: Date.now() },
    ], { llm: routingLlm })
    expect(stats.unrouted).toBe(1)
    const row = ctx.db.prepare('SELECT * FROM unrouted_messages WHERE id = (SELECT MAX(id) FROM unrouted_messages)').get()
    expect(row.content).toBe('就按这个方案办【引用 李四】二期改用混合部署')
  })
})

describe('S78-4 recent_chat/minutes 回读行格式', () => {
  it('S78-4: 专题群讨论回读行并入引用标记（单行【引用 发言人】），供 LLM 解析指代', async () => {
    const p = createProject(ctx.db, { name: '引用项目D', typeCode: 'lianmai_365', leadMemberId: ctx.members.lead.id }, ctx.members.admin.id)
    upsertChannel(ctx.db, { platform: 'feishu', groupKey: 'oc_qrc', channelType: 'dedicated', projectId: p.id })
    const fetchChat = async () => ({ messages: [
      { id: 'om_r1', speakerId: 'fs_zhang', text: '这个完成了', quoteSpeakerId: 'fs_li', quoteText: '#7 联调验证', ts: Date.now() },
      { id: 'om_r2', speakerId: 'fs_li', text: '收到', ts: Date.now() },
    ] })
    const out = await runRecentChatTool(ctx.db, { platform: 'feishu', chatId: 'oc_qrc', chatType: 'group' }, { fetchChat })
    expect(out).toContain('张三：这个完成了【引用 李四】#7 联调验证')
    expect(out).toContain('李四：收到') // 无引用消息行格式不变
  })
})

let replySeq = 0
function recorder0() {
  const sent = []
  return { sent, send: async (m) => { sent.push(m); return { messageId: `s78_bot_${++replySeq}` } } }
}
