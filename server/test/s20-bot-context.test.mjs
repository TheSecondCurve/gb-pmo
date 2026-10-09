import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { setupApp, loginCookie, authed } from './helpers.mjs'
import { BOT_SECRET as SECRET, scriptedLlm, makeRecorder, makeMsgFactory, mkProject } from './bot-kit.mjs'
import { handleBotEvent, handleCardAction } from '../brain/bot/command.js'
import { syncBot } from '../brain/bot/gateway.js'
import { getSetting, setSetting } from '../engine/settings.js'

// PRD S20 — 机器人指令通道·会话面：多轮上下文注入与指代（S20-13/14/15）+ 配置台热生效（S20-12）。

let ctx
const recorder = makeRecorder()
const { nextMsgId } = makeMsgFactory()

beforeAll(async () => {
  ctx = await setupApp()
})
afterAll(() => ctx?.db.close())

// S20-13/14/15（v0.23）— 机器人多轮上下文：会话域 (platform, chat_id)、双上限（条数+字数）、
// 空闲窗静默开新、/new 水位线；注入裁剪负面清单（斜杠/门禁/未绑定/web 不进）；
// 确认卡与卡片点按结果落 bot_reply 回执文本、可被后续追问指代。
describe('S20 机器人多轮上下文 — 注入与指代', () => {
  const chat = (chatId, openId, text, chatType = 'p2p') => ({ messageId: nextMsgId(), chatId, chatType, senderOpenId: openId, text, ts: Date.now() })
  const seedTurn = (chatId, { user = '问一句', bot = '答一句', at = Date.now(), member = ctx.members.lead.id, botIntent = 'reply' } = {}) => {
    ctx.db.prepare(
      `INSERT INTO bot_commands (message_id, platform, chat_id, chat_type, sender_open_id, member_id, kind, raw_text, intent, result, created_at)
       VALUES (?, 'feishu', ?, 'p2p', 'ou_seed', ?, 'command', ?, 'reply', 'replied', ?)`
    ).run(nextMsgId(), chatId, member, user, at)
    ctx.db.prepare(
      `INSERT INTO bot_commands (message_id, platform, chat_id, chat_type, kind, raw_text, intent, created_at)
       VALUES (?, 'feishu', ?, 'p2p', 'bot_reply', ?, ?, ?)`
    ).run(nextMsgId(), chatId, bot, botIntent, at + 1)
  }

  it('S20-13: 同会话追问携带最近问答历史（user/assistant 成对）+ 提示词「历史仅供指代」规则', async () => {
    const cid = 'oc_ctx_p2p'
    const first = scriptedLlm(JSON.stringify({ action: 'reply', text: '客户I系统共 4 个任务，进展正常。' }))
    await handleBotEvent(ctx.db, chat(cid, 'fs_zhang', '客户I系统怎么样？'), { llm: first.llm, send: recorder().send, secret: SECRET })
    const second = scriptedLlm(JSON.stringify({ action: 'reply', text: '它一切正常。' }))
    const rec = recorder()
    await handleBotEvent(ctx.db, chat(cid, 'fs_zhang', '它的逾期任务呢？'), { llm: second.llm, send: rec.send, secret: SECRET })
    const msgs = second.calls[0]
    expect(msgs).toHaveLength(4) // system + 历史 user + 历史 assistant + 当前 user
    expect(msgs[1]).toEqual({ role: 'user', content: '客户I系统怎么样？' })
    expect(msgs[2].role).toBe('assistant')
    expect(msgs[2].content).toContain('客户I系统共 4 个任务')
    expect(msgs[3]).toEqual({ role: 'user', content: '它的逾期任务呢？' })
    // 先查后答不变量优先于参考历史
    expect(msgs[0].content).toContain('仅供理解指代')
    expect(msgs[0].content).toContain('以本轮 query/metric 取回为准')
    // 首问（无历史）不带该规则
    expect(first.calls[0][0].content).not.toContain('仅供理解指代')
  })

  it('S20-13: 群聊会话全群共享，user 历史条目带说话人名前缀（B 接 A 的话头指代不断线）', async () => {
    const cid = 'oc_ctx_grp'
    const a = scriptedLlm(JSON.stringify({ action: 'reply', text: '客户K系统有 3 个未完成任务。' }))
    await handleBotEvent(ctx.db, chat(cid, 'fs_zhang', '客户K系统现在怎么样', 'group'), { llm: a.llm, send: recorder().send, secret: SECRET })
    const b = scriptedLlm(JSON.stringify({ action: 'reply', text: '好的。' }))
    await handleBotEvent(ctx.db, chat(cid, 'fs_li', '它们分别谁负责', 'group'), { llm: b.llm, send: recorder().send, secret: SECRET })
    const msgs = b.calls[0]
    expect(msgs[1].content.startsWith('张三：')).toBe(true)
    expect(msgs[2].content).toContain('客户K系统有 3 个未完成任务')
    expect(msgs[3].content).toBe('它们分别谁负责') // 当前消息不加前缀
  })

  it('S20-14: /new 落水位线立即清空并回执（已登记数据不受影响）；未绑定用户发 /new 回绑定引导', async () => {
    const cid = 'oc_ctx_new'
    const eventsBefore = ctx.db.prepare('SELECT COUNT(*) AS n FROM project_events').get().n
    await handleBotEvent(ctx.db, chat(cid, 'fs_zhang', '客户L系统怎么样'), { llm: scriptedLlm(JSON.stringify({ action: 'reply', text: '正常。' })).llm, send: recorder().send, secret: SECRET })
    const resetRec = recorder()
    const reset = await handleBotEvent(ctx.db, chat(cid, 'fs_zhang', '/new'), { send: resetRec.send, secret: SECRET })
    expect(reset.result).toBe('reset')
    expect(resetRec.sent[0].text).toContain('不受影响')
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM bot_context_resets WHERE chat_id = ?').get(cid).n).toBe(1)
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM project_events').get().n).toBe(eventsBefore)
    // 清空后追问：无历史
    const after = scriptedLlm(JSON.stringify({ action: 'reply', text: '重新开始。' }))
    await handleBotEvent(ctx.db, chat(cid, 'fs_zhang', '那现在呢'), { llm: after.llm, send: recorder().send, secret: SECRET })
    expect(after.calls[0]).toHaveLength(2)
    // 未绑定用户：无记忆可清，回绑定引导
    const guideRec = recorder()
    const guide = await handleBotEvent(ctx.db, chat('oc_ctx_new2', 'fs_ghost', '/new'), { send: guideRec.send, secret: SECRET })
    expect(guide.result).toBe('guidance')
    expect(guideRec.sent[0].text).toContain('/bind')
  })

  it('S20-14: 空闲超 contextIdleMinutes 静默开新会话；contextTurns=0 整体关闭多轮记忆', async () => {
    const cid = 'oc_ctx_idle'
    await handleBotEvent(ctx.db, chat(cid, 'fs_zhang', '客户M系统怎么样'), { llm: scriptedLlm(JSON.stringify({ action: 'reply', text: '正常。' })).llm, send: recorder().send, secret: SECRET })
    // 把该会话全部行拨回 3 小时前（默认空闲窗 120 分钟）
    ctx.db.prepare('UPDATE bot_commands SET created_at = ? WHERE chat_id = ?').run(Date.now() - 3 * 3600_000, cid)
    const stale = scriptedLlm(JSON.stringify({ action: 'reply', text: '新会话。' }))
    await handleBotEvent(ctx.db, chat(cid, 'fs_zhang', '继续问'), { llm: stale.llm, send: recorder().send, secret: SECRET })
    expect(stale.calls[0]).toHaveLength(2) // 静默开新：无历史、无提示
    // contextTurns=0：窗口内的新对话也不注入
    const off = 'oc_ctx_off'
    await handleBotEvent(ctx.db, chat(off, 'fs_zhang', '客户N系统怎么样'), { llm: scriptedLlm(JSON.stringify({ action: 'reply', text: '正常。' })).llm, send: recorder().send, secret: SECRET })
    setSetting(ctx.db, 'im.feishu', { contextTurns: 0 }, 1)
    const after = scriptedLlm(JSON.stringify({ action: 'reply', text: '单条独立。' }))
    await handleBotEvent(ctx.db, chat(off, 'fs_zhang', '再问一句'), { llm: after.llm, send: recorder().send, secret: SECRET })
    expect(after.calls[0]).toHaveLength(2)
    setSetting(ctx.db, 'im.feishu', {}, 1) // 恢复默认
  })

  it('S20-15: 斜杠命令/门禁引导/未绑定消息/web 会话不进上下文；回复文本落 bot_reply.raw_text', async () => {
    const cid = 'oc_ctx_gate'
    const rec = recorder()
    await handleBotEvent(ctx.db, chat(cid, 'fs_zhang', '/help'), { send: rec.send, secret: SECRET })
    await handleBotEvent(ctx.db, chat(cid, 'fs_ghost2', '我的任务'), { llm: scriptedLlm().llm, send: rec.send, secret: SECRET }) // 未绑定引导
    ctx.db.prepare(
      `INSERT INTO bot_commands (message_id, platform, chat_id, chat_type, sender_open_id, member_id, kind, raw_text, intent, result, created_at)
       VALUES (?, 'web', ?, 'p2p', 'ou_web', 1, 'command', 'web 会话消息', 'reply', 'replied', ?)`
    ).run(nextMsgId(), cid, Date.now())
    // 真实问答（唯一可注入对）+ 追问
    await handleBotEvent(ctx.db, chat(cid, 'fs_zhang', '客户O系统怎么样'), { llm: scriptedLlm(JSON.stringify({ action: 'reply', text: '客户O系统一切正常。' })).llm, send: rec.send, secret: SECRET })
    const follow = scriptedLlm(JSON.stringify({ action: 'reply', text: '好。' }))
    await handleBotEvent(ctx.db, chat(cid, 'fs_zhang', '它的风险呢'), { llm: follow.llm, send: rec.send, secret: SECRET })
    const hist = follow.calls[0].slice(1, -1) // 历史区
    expect(hist).toHaveLength(2)
    expect(hist.map((m) => m.content).join('\n')).not.toContain('/help')
    expect(hist.map((m) => m.content).join('\n')).not.toContain('绑定')
    expect(hist.map((m) => m.content).join('\n')).not.toContain('web 会话消息')
    // LLM 回复文本落审计行（kind=bot_reply 带原文）
    const replyRows = ctx.db.prepare(`SELECT raw_text FROM bot_commands WHERE chat_id = ? AND kind = 'bot_reply' AND raw_text IS NOT NULL ORDER BY id`).all(cid)
    expect(replyRows.some((r) => r.raw_text.includes('客户O系统一切正常'))).toBe(true)
  })

  it('S20-15: 确认卡合成回执与卡片点按结果落 bot_reply 文本，可被同会话后续追问指代', async () => {
    const p = await mkProject(ctx, '客户P系统', ctx.members.lead.id)
    const taskId = ctx.db.prepare('SELECT id FROM tasks WHERE project_id = ? ORDER BY id').get(p.id).id
    const cid = 'oc_ctx_card'
    const { llm } = scriptedLlm(JSON.stringify({ action: 'write', kind: 'suggest_event', payload: { targetTaskId: taskId, targetField: 'status', targetValue: 'done' } }))
    const cardRec = recorder()
    await handleBotEvent(ctx.db, chat(cid, 'fs_zhang', `把任务 #${taskId} 标为完成`), { llm, send: cardRec.send, secret: SECRET })
    // 卡片发送 → bot_reply 落合成回执（含事件号与摘要）
    const cardRow = ctx.db.prepare(`SELECT raw_text FROM bot_commands WHERE chat_id = ? AND kind = 'bot_reply'`).get(cid)
    expect(cardRow.raw_text).toContain(`#${ctx.db.prepare('SELECT id FROM project_events WHERE target_task_id = ? ORDER BY id DESC').get(taskId).id}`)
    expect(cardRow.raw_text).toContain('待确认')
    // 追问「确认一下」之前，历史里已能指代该卡
    const q1 = scriptedLlm(JSON.stringify({ action: 'reply', text: '在等你点确认卡。' }))
    await handleBotEvent(ctx.db, chat(cid, 'fs_zhang', '确认一下'), { llm: q1.llm, send: recorder().send, secret: SECRET })
    expect(q1.calls[0].some((m) => m.role === 'assistant' && m.content.includes('待确认'))).toBe(true)
    // 点按生效 → 结果回复也落文本 → 下一轮历史含「已生效」
    const btn = cardRec.sent[0].card.elements.find((e) => e.tag === 'action').actions[0]
    const okRec = recorder()
    await handleCardAction(ctx.db, { operatorOpenId: 'fs_zhang', value: btn.value, chatId: cid, messageId: nextMsgId() }, { send: okRec.send, secret: SECRET })
    expect(okRec.sent[0].text).toContain('已生效')
    const outcomeRow = ctx.db.prepare(`SELECT raw_text FROM bot_commands WHERE chat_id = ? AND kind = 'bot_reply' AND raw_text LIKE '%已生效%'`).get(cid)
    expect(outcomeRow.raw_text).toContain('已生效')
    const q2 = scriptedLlm(JSON.stringify({ action: 'reply', text: '已生效。' }))
    await handleBotEvent(ctx.db, chat(cid, 'fs_zhang', '它生效了吗'), { llm: q2.llm, send: recorder().send, secret: SECRET })
    expect(q2.calls[0].some((m) => m.role === 'assistant' && m.content.includes('已生效'))).toBe(true)
  })

  it('S20-13: 历史装配纯函数——条数/字数双上限、单条截断、空闲窗、水位线', async () => {
    const { listBotHistory } = await import('../brain/bot/history.js')
    const scope = { platform: 'feishu', chatId: 'oc_unit', chatType: 'p2p' }
    // 条数上限：取最新 N 条（条=user/assistant 各算一条，与 web 会话 12 条语义一致）
    const c1 = 'oc_u1'
    for (let i = 1; i <= 3; i++) seedTurn(c1, { user: `第${i}问`, bot: `第${i}答`, at: Date.now() - (10 - i) * 1000 })
    expect(listBotHistory(ctx.db, { ...scope, chatId: c1 }, { turns: 2 }).map((m) => m.content)).toEqual(['第3问', '第3答'])
    // 字数上限：单条截 600，总预算 6000 → 条数放宽到 24 时由字数先触顶
    const c2 = 'oc_u2'
    for (let i = 1; i <= 12; i++) seedTurn(c2, { user: `问${i}`, bot: '长'.repeat(2000), at: Date.now() - (30 - i) * 1000 })
    const capped = listBotHistory(ctx.db, { ...scope, chatId: c2 }, { turns: 24 })
    expect(capped.length).toBeLessThan(24) // 字数预算先于条数上限截停
    expect(capped.reduce((s, m) => s + m.content.length, 0)).toBeLessThanOrEqual(6000)
    expect(capped[1].content.length).toBe(600) // 单条截断
    // 空闲窗：全部拨回 3h → 空
    const c3 = 'oc_u3'
    seedTurn(c3, { at: Date.now() - 3 * 3600_000 })
    expect(listBotHistory(ctx.db, { ...scope, chatId: c3 })).toEqual([])
    // 水位线：窗口内新对话，/new 后 → 空（cleared_at 确定性晚于回合 10ms：同毫秒时 bot_reply(at+1) 会大于水位线漏过过滤，coverage 插桩下实测踩中）
    const c4 = 'oc_u4'
    const turnAt = Date.now()
    seedTurn(c4, { at: turnAt })
    ctx.db.prepare(`INSERT INTO bot_context_resets (platform, chat_id, member_id, message_id, cleared_at) VALUES ('feishu', ?, 1, 'om_r', ?)`).run(c4, turnAt + 10)
    expect(listBotHistory(ctx.db, { ...scope, chatId: c4 })).toEqual([])
    // 不可注入意图：write:/card: 可进，gate/help/bind/context 不进
    const c5 = 'oc_u5'
    seedTurn(c5, { botIntent: 'write:refused' })
    seedTurn(c5, { botIntent: 'card:confirm', at: Date.now() + 10 })
    seedTurn(c5, { botIntent: 'gate', at: Date.now() + 20 })
    seedTurn(c5, { botIntent: 'help', at: Date.now() + 30 })
    expect(listBotHistory(ctx.db, { ...scope, chatId: c5 }, { turns: 24 }).filter((m) => m.role === 'assistant')).toHaveLength(2)
  })

  it('S20-15: 历史装配失败降级为无历史作答并留审计（detail.historyDegraded）', async () => {
    const cid = 'oc_ctx_degrade'
    await handleBotEvent(ctx.db, chat(cid, 'fs_zhang', '客户Q系统怎么样'), { llm: scriptedLlm(JSON.stringify({ action: 'reply', text: '正常。' })).llm, send: recorder().send, secret: SECRET })
    const ddl = ctx.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='bot_context_resets'").get().sql
    ctx.db.prepare('DROP TABLE bot_context_resets').run()
    try {
      const degraded = scriptedLlm(JSON.stringify({ action: 'reply', text: '降级照常回答。' }))
      const out = await handleBotEvent(ctx.db, chat(cid, 'fs_zhang', '再问一句'), { llm: degraded.llm, send: recorder().send, secret: SECRET })
      expect(out.result).toBe('replied') // 不阻塞主链路
      expect(degraded.calls[0]).toHaveLength(2) // 无历史
      const row = ctx.db.prepare(`SELECT detail FROM bot_commands WHERE chat_id = ? AND kind = 'command' ORDER BY id DESC`).get(cid)
      expect(JSON.parse(row.detail).historyDegraded).toBe(true)
    } finally {
      // 还原表与索引（migrate 不会重跑已应用的 0014），后续用例不受影响
      ctx.db.exec(`${ddl}; CREATE INDEX IF NOT EXISTS idx_bot_context_resets_scope ON bot_context_resets(platform, chat_id, cleared_at);`)
    }
  })
})

// S20-12（v0.22）— 配置台热生效：im.feishu 保存即重连/断开长连接，无需重启进程。
// connect 注入 fake 记录连接/断开；路由测试经 buildApp 的 botSync 注入点验证保存链路（K7：真库 + inject）。
describe('S20-12 配置台热生效', () => {
  it('S20-12: syncBot 按配置热重启——关→不连接；开→连接；再同步→断旧建新；关→断开且不重连', async () => {
    const closed = []
    const connected = []
    let seq = 0
    const connect = async (cfg) => {
      const ws = { id: ++seq, close: () => closed.push(ws.id) }
      connected.push(cfg.appId)
      return { ws, result: { started: true } }
    }
    // 默认 botEnabled=false：不发起连接
    expect((await syncBot(ctx.db, { secret: SECRET, connect })).started).toBe(false)
    expect(connected).toHaveLength(0)
    // 开启 + 凭证齐全：连接一次（setSetting 为整值替换语义，每次写完整对象）
    await setSetting(ctx.db, 'im.feishu', { botEnabled: true, appId: 'cli_hot', appSecret: 'sec' }, ctx.members.admin.id)
    let r = await syncBot(ctx.db, { secret: SECRET, connect })
    expect(r.started).toBe(true)
    expect(connected).toEqual(['cli_hot'])
    // 再次保存（配置重放）：旧连接关闭、新连接建立（换凭证即重连到新应用）
    await setSetting(ctx.db, 'im.feishu', { botEnabled: true, appId: 'cli_hot2', appSecret: 'sec' }, ctx.members.admin.id)
    r = await syncBot(ctx.db, { secret: SECRET, connect })
    expect(r.started).toBe(true)
    expect(connected).toEqual(['cli_hot', 'cli_hot2'])
    expect(closed).toEqual([1])
    // 关闭：断开当前连接且不再发起
    await setSetting(ctx.db, 'im.feishu', { botEnabled: false }, ctx.members.admin.id)
    r = await syncBot(ctx.db, { secret: SECRET, connect })
    expect(r.started).toBe(false)
    expect(r.reason).toContain('botEnabled')
    expect(connected).toHaveLength(2)
    expect(closed).toEqual([1, 2])
  })

  it('S20-12: 开启但凭证缺失→返回明确原因，不连接不抛错（connect 不应被调用）', async () => {
    await setSetting(ctx.db, 'im.feishu', { botEnabled: true, appId: '', appSecret: '' }, ctx.members.admin.id)
    const r = await syncBot(ctx.db, { connect: async () => { throw new Error('不应发起连接') } })
    expect(r.started).toBe(false)
    expect(r.reason).toContain('appId')
    await setSetting(ctx.db, 'im.feishu', { botEnabled: false }, ctx.members.admin.id)
  })

  it('S20-12: PUT /admin/settings/im.feishu 保存后热同步并在响应回显机器人状态；其他 key 不触发热同步', async () => {
    const botSync = vi.fn(async () => ({ started: true }))
    const hot = await setupApp({ botSync })
    try {
      const cookie = await loginCookie(hot.app, 'admin', 'admin-pass-123')
      const res = await authed(hot.app, cookie, 'PUT', '/api/v1/admin/settings/im.feishu', { botEnabled: true, appId: 'cli_x', appSecret: 's' })
      expect(res.status).toBe(200)
      expect(res.body.bot).toEqual({ started: true }) // 启动结果回显（S20-12）
      expect(getSetting(hot.db, 'im.feishu').botEnabled).toBe(true)
      expect(botSync).toHaveBeenCalledTimes(1)
      // 非 im.feishu key：不触发热同步、无 bot 字段
      const res2 = await authed(hot.app, cookie, 'PUT', '/api/v1/admin/settings/chat', { quotaPerDay: 60 })
      expect(res2.status).toBe(200)
      expect(res2.body.bot).toBeUndefined()
      expect(botSync).toHaveBeenCalledTimes(1)
    } finally {
      await hot.db.close()
    }
  })
})
