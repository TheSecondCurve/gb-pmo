import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupApp } from './helpers.mjs'
import { BOT_SECRET as SECRET, scriptedLlm, makeRecorder, makeMsgFactory, mkProject } from './bot-kit.mjs'
import { handleBotEvent } from '../brain/bot/command.js'
import { upsertChannel } from '../engine/tasks.js'
import { setSetting } from '../engine/settings.js'

// PRD S20 — 机器人指令通道·功能面：/tasks 任务盘点（S20-17）、群讨论上下文 recent_chat（S20-18）、
// 私聊占位反馈（S20-19）。独立临时库 + 文件级限额抬高（避免功能用例撞每日限额）。

let ctx
const recorder = makeRecorder()
const { p2p, group } = makeMsgFactory()

beforeAll(async () => {
  ctx = await setupApp()
  setSetting(ctx.db, 'im.feishu', { commandQuotaPerDay: 500 }, 1)
})
afterAll(() => ctx?.db.close())

describe('S20 机器人指令通道 — 任务盘点 /tasks（v0.34）', () => {
  it('S20-17: 专题群 /tasks——本项目全部未完任务，未分配责任人置顶+计数；已完成无主任务不出现（零 LLM，别名等价）', async () => {
    const p = await mkProject(ctx, '盘点甲项目', ctx.members.lead.id)
    // 两条无主未完：一条带截止日，一条无任何日期（口径宽于 S2-1「已设开始日」）
    ctx.db.prepare(`UPDATE tasks SET responsible_member_id = NULL, plan_end_date = '2026-10-08' WHERE id = (SELECT id FROM tasks WHERE project_id = ? ORDER BY id LIMIT 1)`).run(p.id)
    ctx.db.prepare(`UPDATE tasks SET responsible_member_id = NULL, plan_start_date = NULL, plan_end_date = NULL WHERE id = (SELECT id FROM tasks WHERE project_id = ? ORDER BY id LIMIT 1 OFFSET 1)`).run(p.id)
    // 一条已完成的无主任务：盘点口径是未完（status != done），不应出现
    ctx.db.prepare(`UPDATE tasks SET title = '已完成的无主任务X9', responsible_member_id = NULL, status = 'done', actual_end_date = '2026-10-01' WHERE id = (SELECT id FROM tasks WHERE project_id = ? ORDER BY id LIMIT 1 OFFSET 2)`).run(p.id)
    upsertChannel(ctx.db, { platform: 'feishu', groupKey: 'oc_inv', name: '盘点群', channelType: 'dedicated', projectId: p.id }, ctx.members.admin.id)

    // 零 LLM：不传 llm 也能回（确定性命令，进 LLM 之前）
    const rec = recorder()
    const out = await handleBotEvent(ctx.db, { ...group('fs_zhang', 'oc_inv', '/tasks'), mentioned: true }, { send: rec.send, secret: SECRET })
    expect(out.result).toBe('replied')
    const text = rec.sent[0].text
    expect(text).toContain('盘点甲项目')
    expect(text).toContain('未分配责任人 2 条')
    expect(text).toContain('2026-10-08')
    expect(text).toContain('张三') // 有主任务带负责人名（牵头人默认责任人）
    expect(text).not.toContain('已完成的无主任务X9')

    // 别名 /盘点 等价
    const rec2 = recorder()
    const out2 = await handleBotEvent(ctx.db, { ...group('fs_li', 'oc_inv', '/盘点'), mentioned: true }, { send: rec2.send, secret: SECRET })
    expect(out2.result).toBe('replied')
    expect(rec2.sent[0].text).toContain('盘点甲项目')
  })

  it('S20-17: 私聊 /tasks——全部在跑项目未分配任务按项目分组；全有主项目明确说明', async () => {
    const pa = await mkProject(ctx, '盘点乙项目', ctx.members.lead.id)
    await mkProject(ctx, '盘点丙项目', ctx.members.lead.id)
    ctx.db.prepare(`UPDATE tasks SET responsible_member_id = NULL WHERE id = (SELECT id FROM tasks WHERE project_id = ? ORDER BY id LIMIT 1)`).run(pa.id)
    // 乙项目造一条独特标题无主任务，断言分组归属
    ctx.db.prepare(`INSERT INTO tasks (project_id, title, responsible_member_id, status, source, created_at, updated_at) VALUES (?, '盘点乙独有无主任务Q7', NULL, 'todo', 'manual', ?, ?)`).run(pa.id, Date.now(), Date.now())

    const rec = recorder()
    const out = await handleBotEvent(ctx.db, p2p('fs_zhang', '/tasks'), { send: rec.send, secret: SECRET })
    expect(out.result).toBe('replied')
    const text = rec.sent[0].text
    expect(text).toContain('盘点乙项目')
    expect(text).toContain('盘点乙独有无主任务Q7')
    expect(text).toContain('盘点丙项目')
    expect(text).toContain('均已分配') // 丙项目全有主
  })

  it('S20-17: 未绑定成员 /tasks 回绑定引导（同 /morning）；engine tasksInventory 口径直调', async () => {
    const rec = recorder()
    const out = await handleBotEvent(ctx.db, p2p('fs_stranger2', '/tasks'), { send: rec.send, secret: SECRET })
    expect(out.result).toBe('guidance')
    expect(rec.sent[0].text).toContain('绑定')

    // engine 直调：无开始日的无主任务也在列（与 S2-1 listUnassigned 的兜底口径并存、语义不同）
    const { tasksInventory } = await import('../engine/tasks.js')
    const p = await mkProject(ctx, '盘点丁项目', ctx.members.lead.id)
    ctx.db.prepare(`UPDATE tasks SET responsible_member_id = NULL, plan_start_date = NULL, plan_end_date = NULL WHERE id = (SELECT id FROM tasks WHERE project_id = ? ORDER BY id LIMIT 1)`).run(p.id)
    const scoped = tasksInventory(ctx.db, { projectId: p.id })
    expect(scoped.text).toContain('未分配责任人 1 条')
    const globalInv = tasksInventory(ctx.db, {})
    expect(globalInv.text).toContain('盘点丁项目')
  })
})

describe('S20 机器人指令通道 — 群讨论上下文 recent_chat（v0.34）', () => {
  it('S20-18: 专题群 recent_chat 拉最近讨论——回看窗/尾条数/说话人映射/机器人消息过滤/不挪游标不产事件', async () => {
    const p = await mkProject(ctx, '讨论甲项目', ctx.members.lead.id)
    upsertChannel(ctx.db, { platform: 'feishu', groupKey: 'oc_rc', name: '讨论群', channelType: 'dedicated', projectId: p.id }, ctx.members.admin.id)
    const cursorBefore = ctx.db.prepare('SELECT cursor FROM channels WHERE group_key = ?').get('oc_rc').cursor
    const eventsBefore = ctx.db.prepare('SELECT COUNT(*) AS n FROM project_events').get().n

    // 机器人自己的一条回复已落 bot_commands（recent_chat 应过滤；回执文本与 fake 消息文本分开，避免多轮历史注入干扰断言）
    const rec0 = recorder()
    await handleBotEvent(ctx.db, { ...group('fs_zhang', 'oc_rc', '@bot 在吗'), mentioned: true }, { llm: scriptedLlm(JSON.stringify({ action: 'reply', text: '预置回执Z3' })).llm, send: rec0.send, secret: SECRET })

    const fetchCalls = []
    const fetchChat = async (cfg, channel, cursor) => {
      fetchCalls.push({ groupKey: channel.groupKey, cursor: Number(cursor) })
      return {
        messages: [
          { id: 'om_rc_1', speakerId: 'fs_zhang', text: '任务还是给小王吧', ts: Date.now() - 60_000 },
          { id: rec0.sent[0].messageId, speakerId: 'ou_bot', text: '机器人回执Y5', ts: Date.now() - 50_000 },
          { id: 'om_rc_2', speakerId: 'fs_stranger', text: '同意，小王最近有空', ts: Date.now() - 40_000 },
        ],
        nextCursor: '9999999999',
      }
    }
    const { llm, calls } = scriptedLlm(
      JSON.stringify({ action: 'recent_chat', limit: 20 }),
      JSON.stringify({ action: 'reply', text: '按刚才讨论：建议把任务转给小王，确认卡已发。' })
    )
    const rec = recorder()
    const out = await handleBotEvent(ctx.db, { ...group('fs_zhang', 'oc_rc', '@bot 按刚才讨论的办'), mentioned: true }, { llm, send: rec.send, secret: SECRET, fetchChat })
    expect(out.result).toBe('replied')

    // 连接器收到回看窗口游标（≈ now - 7200s，允许偏差）
    expect(fetchCalls.length).toBe(1)
    expect(fetchCalls[0].groupKey).toBe('oc_rc')
    expect(Math.abs(fetchCalls[0].cursor - (Math.floor(Date.now() / 1000) - 7200))).toBeLessThan(180)

    // 第二轮 LLM 收到的工具结果：说话人映射、未识别标注、机器人自身消息被过滤
    const feedback = calls[1].map((m) => m.content).join('\n')
    expect(feedback).toContain('张三：任务还是给小王吧')
    expect(feedback).toContain('未识别：同意，小王最近有空')
    expect(feedback).not.toContain('机器人回执Y5')

    // 临时拉取不挪抽取游标、不产生事件
    expect(ctx.db.prepare('SELECT cursor FROM channels WHERE group_key = ?').get('oc_rc').cursor).toBe(cursorBefore)
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM project_events').get().n).toBe(eventsBefore)

    // 系统提示声明 recent_chat 动作
    expect(calls[0][0].content).toContain('recent_chat')
  })

  it('S20-18: 私聊 recent_chat 不可用（返回文案，LLM 走其它路径作答）', async () => {
    const { llm, calls } = scriptedLlm(
      JSON.stringify({ action: 'recent_chat' }),
      JSON.stringify({ action: 'reply', text: '你直接告诉我要调整哪个任务就行。' })
    )
    const rec = recorder()
    const out = await handleBotEvent(ctx.db, p2p('fs_zhang', '按刚才讨论的办'), { llm, send: rec.send, secret: SECRET })
    expect(out.result).toBe('replied')
    const feedback = calls[1].map((m) => m.content).join('\n')
    expect(feedback).toContain('仅项目专题群')
  })
})

// —— v0.36（S20-19）：私聊占位反馈——慢路径先发「收到，正在处理…」，答案就绪把同一条消息原地编辑为最终答复。
// patch 注入编辑记录器（飞书「更新应用发送的消息内容」PUT 的适配层抽象）；未注入 patch=旧契约，行为与今天一致。
describe('S20 机器人私聊占位反馈（v0.36）', () => {
  const patcher = (fail = false) => {
    const patched = []
    return {
      patched,
      patch: async (m) => {
        patched.push(m)
        if (fail) throw new Error('编辑失败')
        return { ok: true }
      },
    }
  }

  // 本地记录器：把出站 messageId 一并记进出站条目（占位反馈断言要比对「同一条消息」，共享 recorder 不存 id）
  const typedRecorder = () => {
    const sent = []
    let n = 0
    return { sent, send: async (m) => { const messageId = `bot_typing_${++n}`; sent.push({ ...m, messageId }); return { messageId } } }
  }

  it('S20-19: 私聊自然语言——占位先发、答案原地编辑同一条消息、不产生第二条回复', async () => {
    const p = await mkProject(ctx, '占位甲项目', ctx.members.lead.id)
    const { llm } = scriptedLlm(
      JSON.stringify({ action: 'query', sql: `SELECT COUNT(*) AS n FROM tasks WHERE project_id = ${p.id}` }),
      JSON.stringify({ action: 'reply', text: '占位甲项目一切正常。' })
    )
    const rec = typedRecorder()
    const pp = patcher()
    const evt = p2p('fs_zhang', '占位甲项目怎么样？')
    const out = await handleBotEvent(ctx.db, evt, { llm, send: rec.send, patch: pp.patch, secret: SECRET })
    expect(out.result).toBe('replied')
    // 只发过一条消息：占位（最终被编辑成答案）
    expect(rec.sent).toHaveLength(1)
    expect(rec.sent[0].text).toContain('正在处理')
    // 原地编辑：同一条 message_id 被替换为最终文本
    expect(pp.patched).toHaveLength(1)
    expect(pp.patched[0].messageId).toBe(rec.sent[0].messageId)
    expect(pp.patched[0].chatId).toBe(evt.chatId)
    expect(pp.patched[0].text).toContain('占位甲项目一切正常')
    // 审计口径不变：占位消息 id 即最终答复 bot_reply 回执行的 id（S20-15 语义）
    const replyRow = ctx.db.prepare('SELECT * FROM bot_commands WHERE message_id = ?').get(rec.sent[0].messageId)
    expect(replyRow.kind).toBe('bot_reply')
    expect(replyRow.raw_text).toContain('占位甲项目一切正常')
  })

  it('S20-19: 斜杠命令/门禁引导/LLM 未配置不占位（毫秒级出口单条直达）', async () => {
    const rec1 = typedRecorder(); const pp1 = patcher()
    await handleBotEvent(ctx.db, p2p('fs_zhang', '/help'), { send: rec1.send, patch: pp1.patch, secret: SECRET })
    expect(rec1.sent).toHaveLength(1)
    expect(rec1.sent[0].text).toContain('/new')
    expect(pp1.patched).toHaveLength(0)

    const rec2 = typedRecorder(); const pp2 = patcher()
    const out2 = await handleBotEvent(ctx.db, p2p('fs_ghost19', '我的任务'), { llm: scriptedLlm().llm, send: rec2.send, patch: pp2.patch, secret: SECRET })
    expect(out2.result).toBe('guidance')
    expect(rec2.sent).toHaveLength(1)
    expect(rec2.sent[0].text).toContain('/bind')
    expect(pp2.patched).toHaveLength(0)

    const rec3 = typedRecorder(); const pp3 = patcher()
    const out3 = await handleBotEvent(ctx.db, p2p('fs_zhang', '随便问问不配置 LLM'), { send: rec3.send, patch: pp3.patch, secret: SECRET })
    expect(out3.result).toBe('no_llm')
    expect(rec3.sent).toHaveLength(1)
    expect(rec3.sent[0].text).toContain('/help')
    expect(pp3.patched).toHaveLength(0)
  })

  it('S20-19: 编辑失败降级——答案改发新消息必达（占位留在原地）', async () => {
    const { llm } = scriptedLlm(JSON.stringify({ action: 'reply', text: '降级路径的答案。' }))
    const rec = typedRecorder()
    const pp = patcher(true) // 编辑必失败
    const out = await handleBotEvent(ctx.db, p2p('fs_zhang', '再问一句'), { llm, send: rec.send, patch: pp.patch, secret: SECRET })
    expect(out.result).toBe('replied')
    expect(rec.sent).toHaveLength(2) // 占位 + 另发的答案
    expect(rec.sent[0].text).toContain('正在处理')
    expect(rec.sent[1].text).toContain('降级路径的答案')
    expect(pp.patched).toHaveLength(1) // 尝试过编辑
    // 降级路径审计照落（新消息 id 的 bot_reply）
    const replyRow = ctx.db.prepare('SELECT * FROM bot_commands WHERE message_id = ?').get(rec.sent[1].messageId)
    expect(replyRow.kind).toBe('bot_reply')
    expect(replyRow.raw_text).toContain('降级路径的答案')
  })

  it('S20-19: 群聊不占位（一期仅私聊）；typingFeedback=false 恢复单条回复形态', async () => {
    const { llm } = scriptedLlm(JSON.stringify({ action: 'reply', text: '群里直接答。' }))
    const rec = typedRecorder(); const pp = patcher()
    const out = await handleBotEvent(ctx.db, { ...group('fs_zhang', 'oc_typing_g', '@bot 在吗'), mentioned: true }, { llm, send: rec.send, patch: pp.patch, secret: SECRET })
    expect(out.result).toBe('replied')
    expect(rec.sent).toHaveLength(1)
    expect(rec.sent[0].text).toContain('群里直接答')
    expect(pp.patched).toHaveLength(0)

    setSetting(ctx.db, 'im.feishu', { typingFeedback: false, commandQuotaPerDay: 500 }, 1)
    try {
      const rec2 = typedRecorder(); const pp2 = patcher()
      const out2 = await handleBotEvent(ctx.db, p2p('fs_zhang', '又一句'), { llm: scriptedLlm(JSON.stringify({ action: 'reply', text: '开关关了。' })).llm, send: rec2.send, patch: pp2.patch, secret: SECRET })
      expect(out2.result).toBe('replied')
      expect(rec2.sent).toHaveLength(1)
      expect(rec2.sent[0].text).toContain('开关关了')
      expect(pp2.patched).toHaveLength(0)
    } finally {
      setSetting(ctx.db, 'im.feishu', { commandQuotaPerDay: 500 }, 1) // 整值替换语义：恢复默认 typingFeedback=true
    }
  })

  it('S20-19: 卡片出口——占位编辑为合成回执文本，确认卡照发；编辑失败不阻塞卡片', async () => {
    const p = await mkProject(ctx, '占位乙项目', ctx.members.lead.id)
    const taskId = ctx.db.prepare('SELECT id FROM tasks WHERE project_id = ? ORDER BY id').get(p.id).id
    const { llm } = scriptedLlm(
      JSON.stringify({ action: 'write', kind: 'suggest_event', payload: { targetTaskId: taskId, targetField: 'status', targetValue: 'done' } })
    )
    const rec = typedRecorder(); const pp = patcher()
    const out = await handleBotEvent(ctx.db, p2p('fs_zhang', `把任务 #${taskId} 标为完成`), { llm, send: rec.send, patch: pp.patch, secret: SECRET })
    expect(out.result).toBe('card_sent')
    expect(rec.sent).toHaveLength(2) // 占位 + 卡片
    expect(rec.sent[0].text).toContain('正在处理')
    expect(rec.sent[1].card).toBeTruthy()
    expect(pp.patched).toHaveLength(1) // 占位被编辑为回执文本
    expect(pp.patched[0].messageId).toBe(rec.sent[0].messageId)
    expect(pp.patched[0].text).toContain('待确认')

    // 编辑失败：卡片仍必达（占位留在原地）
    const rec2 = typedRecorder(); const pp2 = patcher(true)
    const out2 = await handleBotEvent(ctx.db, p2p('fs_li', `把任务 #${taskId} 标为完成`), { llm: scriptedLlm(JSON.stringify({ action: 'write', kind: 'suggest_event', payload: { targetTaskId: taskId, targetField: 'status', targetValue: 'doing' } })).llm, send: rec2.send, patch: pp2.patch, secret: SECRET })
    expect(out2.result).toBe('card_sent')
    expect(rec2.sent.some((m) => m.card)).toBe(true)
  })

  it('S20-19: patchText 以 PUT /im/v1/messages/:message_id 编辑应用消息（msg_type=text，全量内容）', async () => {
    const real = globalThis.fetch
    const calls = []
    globalThis.fetch = async (url, opts = {}) => {
      const u = String(url)
      if (u.includes('/auth/v3/tenant_access_token')) return new Response(JSON.stringify({ code: 0, tenant_access_token: 't-1' }), { status: 200 })
      if (u.includes('/im/v1/messages/om_edit_1') && opts?.method === 'PUT') {
        calls.push({ url: u, body: JSON.parse(opts.body) })
        return new Response(JSON.stringify({ code: 0 }), { status: 200 })
      }
      throw new Error('unexpected fetch: ' + u + ' ' + String(opts?.method || ''))
    }
    try {
      const { patchText } = await import('../brain/connectors/feishu.js')
      const r = await patchText({ appId: 'cli_x', appSecret: 's' }, 'om_edit_1', '替换后的答案')
      expect(r.ok).toBe(true)
      expect(calls).toHaveLength(1)
      expect(calls[0].url).toContain('/im/v1/messages/om_edit_1')
      expect(calls[0].body.msg_type).toBe('text')
      expect(JSON.parse(calls[0].body.content).text).toBe('替换后的答案')
    } finally {
      globalThis.fetch = real
    }
  })
})
