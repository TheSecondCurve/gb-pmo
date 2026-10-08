import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { setupApp, loginCookie, authed } from './helpers.mjs'
import { upsertChannel } from '../engine/tasks.js'
import { ingestMessages } from '../brain/extract.js'
import { handleBotEvent, handleCardAction, issueBindCode, buildBindCard } from '../brain/bot/command.js'
import { syncBot, parseSdkMessage, extractMessageText } from '../brain/bot/gateway.js'
import { sendText, sendCard } from '../brain/connectors/feishu.js'
import { runReadOnlyQuery } from '../agent/sqlGuard.js'
import { runWriteTool } from '../brain/bot/tools.js'
import { runAgentLoop } from '../brain/bot/agent.js'
import { getSetting, setSetting } from '../engine/settings.js'

// PRD S20 — 机器人指令通道（读自由写收敛 / 身份门禁 / 确认卡 / 群登记 / 审计去重）
// fake LLM 注入脚本化 JSON 动作，send 注入记录器；不走真实飞书与真实 LLM（K7：真库 + inject）。

const SECRET = 's20-test-bot-hmac-secret-32-bytes!'

let ctx
let seq = 0
const nextMsgId = () => `om_s20_${++seq}`

/** 脚本化 fake LLM：依次弹出动作 JSON，并记录收到的 messages（断言 system prompt）。 */
function scriptedLlm(...actions) {
  const calls = []
  return {
    calls,
    llm: {
      name: 'fake',
      complete: async (messages) => {
        calls.push(messages)
        return String(actions.shift() ?? '{"action":"reply","text":"（脚本耗尽）"}')
      },
    },
  }
}

let replySeq = 0 // 出站 messageId 全局自增：recorder 各自从 1 起算会与共享库既有 bot_reply 行撞 message_id（INSERT OR IGNORE 静默丢行）
const recorder = () => {
  const sent = []
  return { sent, send: async (m) => { sent.push(m); return { messageId: `bot_${++replySeq}` } } }
}

const p2p = (openId, text) => ({ messageId: nextMsgId(), chatId: 'oc_p2p', chatType: 'p2p', senderOpenId: openId, text, ts: Date.now() })
const group = (openId, chatId, text, extra = {}) => ({ messageId: nextMsgId(), chatId, chatType: 'group', senderOpenId: openId, text, ts: Date.now(), ...extra })

async function mkProject(name, leadId) {
  const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
  const res = await authed(ctx.app, cookie, 'POST', '/api/v1/projects', {
    name, templateCode: 'lianmai_365', leadMemberId: leadId, planEndDate: '2026-12-31',
  })
  return res.body
}

const botRow = (messageId) => ctx.db.prepare('SELECT * FROM bot_commands WHERE message_id = ?').get(messageId)

beforeAll(async () => {
  ctx = await setupApp()
})
afterAll(() => ctx?.db.close())

describe('S20 机器人指令通道 — 门禁与查询', () => {
  it('S20-1: 私聊自然语言多轮查询，先查后答 + 全审计', async () => {
    const p = await mkProject('客户A系统', ctx.members.lead.id)
    const taskId = ctx.db.prepare('SELECT id FROM tasks WHERE project_id = ? ORDER BY id').get(p.id).id
    const { llm, calls } = scriptedLlm(
      JSON.stringify({ action: 'query', sql: `SELECT id, title, status FROM tasks WHERE responsible_member_id = ${ctx.members.lead.id} AND status != 'done'` }),
      JSON.stringify({ action: 'reply', text: '你名下有 1 个未完成任务：#1 需求确认（未开始）。' })
    )
    const rec = recorder()
    const evt = p2p('fs_zhang', '我的任务有哪些？')
    const out = await handleBotEvent(ctx.db, evt, { llm, send: rec.send, secret: SECRET })
    expect(out.result).toBe('replied')
    expect(rec.sent[0].text).toContain('未完成任务')
    // system prompt：身份 + schema + 私聊上下文
    const sys = calls[0][0].content
    expect(sys).toContain('张三')
    expect(sys).toContain('tasks(')
    expect(sys).toContain('私聊')
    // 审计：result/llm_calls/detail.sql；机器人回复也落行（S20-10 的另一半）
    const row = botRow(evt.messageId)
    expect(row.result).toBe('replied')
    expect(row.llm_calls).toBe(2)
    expect(JSON.parse(row.detail).sql).toHaveLength(1)
    expect(botRow('bot_1').kind).toBe('bot_reply')
    expect(taskId).toBeGreaterThan(0)
  })

  it('S20-4: 未绑定私聊只回引导；/bind 绑定码闭环（含过期）；LLM 未配置降级', async () => {
    // 未绑定 → 引导，不进 LLM
    const rec0 = recorder()
    const out0 = await handleBotEvent(ctx.db, p2p('fs_new', '我的任务'), { llm: scriptedLlm().llm, send: rec0.send, secret: SECRET })
    expect(out0.result).toBe('guidance')
    expect(rec0.sent[0].text).toContain('/bind')

    // web 端点生成绑定码（王五无 feishuId）
    const cookie = await loginCookie(ctx.app, 'wangwu', 'pass-123456')
    const res = await authed(ctx.app, cookie, 'POST', '/api/v1/auth/feishu-bind-code')
    expect(res.status).toBe(200)
    expect(res.body.code).toMatch(/^\d{6}$/)
    const rec1 = recorder()
    const out1 = await handleBotEvent(ctx.db, p2p('fs_new', `/bind ${res.body.code}`), { send: rec1.send, secret: SECRET })
    expect(out1.result).toBe('bound')
    expect(rec1.sent[0].text).toContain('王五')
    expect(ctx.db.prepare('SELECT feishu_id FROM members WHERE id = ?').get(ctx.members.key.id).feishu_id).toBe('fs_new')

    // 绑定码一次性：再用 → invalid
    const rec2 = recorder()
    const out2 = await handleBotEvent(ctx.db, p2p('fs_new2', `/bind ${res.body.code}`), { send: rec2.send, secret: SECRET })
    expect(out2.result).toBe('guidance')
    expect(rec2.sent[0].text).toContain('无效或已过期')

    // 过期码
    const expired = issueBindCode(ctx.db, ctx.members.dev.id, { ttlMs: -1 })
    const rec3 = recorder()
    const out3 = await handleBotEvent(ctx.db, p2p('fs_new3', `/bind ${expired.code}`), { send: rec3.send, secret: SECRET })
    expect(out3.result).toBe('guidance')

    // 绑定后正常可用 + LLM 未配置降级（只支持斜杠）
    const rec4 = recorder()
    const out4 = await handleBotEvent(ctx.db, p2p('fs_new', '我的任务'), { send: rec4.send, secret: SECRET })
    expect(out4.result).toBe('no_llm')
    expect(rec4.sent[0].text).toContain('/help')
  })
})

describe('S20 机器人指令通道 — 写路径（确认卡）', () => {
  it('S20-2: 口述变更 → pending 建议 + 确认卡；任意绑定成员确认生效留痕；未绑定/伪造签名被拒（v0.34）', async () => {
    const p = await mkProject('客户B系统', ctx.members.lead.id)
    const taskId = ctx.db.prepare('SELECT id FROM tasks WHERE project_id = ? ORDER BY id').get(p.id).id
    const { llm } = scriptedLlm(
      JSON.stringify({ action: 'write', kind: 'suggest_event', payload: { targetTaskId: taskId, targetField: 'status', targetValue: 'done' } })
    )
    const rec = recorder()
    const out = await handleBotEvent(ctx.db, p2p('fs_zhang', `把任务 #${taskId} 标为完成`), { llm, send: rec.send, secret: SECRET })
    expect(out.result).toBe('card_sent')
    const evtRow = ctx.db.prepare('SELECT * FROM project_events WHERE target_task_id = ? ORDER BY id DESC').get(taskId)
    expect(evtRow.nature).toBe('suggestion')
    expect(evtRow.status).toBe('pending')
    expect(evtRow.generated_by).toBe('agent')
    expect(evtRow.source_platform).toBe('feishu')
    expect(evtRow.speaker_member_id).toBe(ctx.members.lead.id)
    // 推送目标任务责任人 + 牵头人（都是牵头人 → 去重 1 条）
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM pushes WHERE related_project_id = ?').get(p.id).n).toBe(1)
    // 卡片按钮
    const card = rec.sent[0].card
    const confirmBtn = card.elements.find((e) => e.tag === 'action').actions[0]
    expect(confirmBtn.value.a).toBe('confirm')

    // 未绑定操作者点确认 → 拒，事件仍 pending（身份门禁保留）
    const unbound = await handleCardAction(ctx.db, { operatorOpenId: 'fs_nobody', value: confirmBtn.value, chatId: 'oc_p2p', messageId: nextMsgId() }, { send: recorder().send, secret: SECRET })
    expect(unbound.result).toBe('refused_permission')
    expect(ctx.db.prepare('SELECT status FROM project_events WHERE id = ?').get(evtRow.id).status).toBe('pending')

    // 伪造签名 → 拒
    const forged = await handleCardAction(ctx.db, { operatorOpenId: 'fs_zhang', value: { ...confirmBtn.value, s: 'deadbeef' }, chatId: 'oc_p2p', messageId: nextMsgId() }, { send: recorder().send, secret: SECRET })
    expect(forged.result).toBe('error')

    // 普通成员（李四：非责任人/非牵头人/非管理员）确认 → 生效、留痕（v0.34 全员可确认，与 web 端点口径一致）
    const okRec = recorder()
    const ok = await handleCardAction(ctx.db, { operatorOpenId: 'fs_li', value: confirmBtn.value, chatId: 'oc_p2p', messageId: nextMsgId() }, { send: okRec.send, secret: SECRET })
    expect(ok.result).toBe('confirmed')
    expect(okRec.sent[0].text).toContain('已生效')
    const after = ctx.db.prepare('SELECT status, decided_by FROM project_events WHERE id = ?').get(evtRow.id)
    expect(after.status).toBe('effective')
    expect(after.decided_by).toBe(ctx.members.dev.id)
    expect(ctx.db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId).status).toBe('done')
  })

  it('S20-3: 口述登记记录型事件自动生效，归因发令人', async () => {
    const p = await mkProject('客户C系统', ctx.members.lead.id)
    const { llm } = scriptedLlm(
      JSON.stringify({ action: 'write', kind: 'record_event', payload: { projectId: p.id, eventType: 'risk', summary: '客户环境未就绪，验收可能顺延' } })
    )
    const rec = recorder()
    const evt = p2p('fs_zhang', '登记风险：客户环境未就绪，验收可能顺延')
    const out = await handleBotEvent(ctx.db, evt, { llm, send: rec.send, secret: SECRET })
    expect(out.result).toBe('replied')
    expect(rec.sent[0].text).toContain('已登记')
    const row = ctx.db.prepare('SELECT * FROM project_events WHERE project_id = ? ORDER BY id DESC').get(p.id)
    expect(row.nature).toBe('record')
    expect(row.status).toBe('effective')
    expect(row.event_type).toBe('risk')
    expect(row.speaker_label).toBe('张三')
    expect(row.raw_snapshot).toContain('客户环境未就绪')
    expect(row.source_ref).toBe(evt.messageId)
  })
})

describe('S20 机器人指令通道 — 群聊', () => {
  it('S20-6: 群@未绑定成员静默忽略留审计（不回复不产事件）', async () => {
    const rec = recorder()
    const evt = group('fs_stranger', 'oc_g1', '@bot 我的任务')
    const out = await handleBotEvent(ctx.db, evt, { llm: scriptedLlm().llm, send: rec.send, secret: SECRET })
    expect(out.result).toBe('ignored_unbound')
    expect(rec.sent).toHaveLength(0)
    expect(botRow(evt.messageId).result).toBe('ignored_unbound')
  })

  it('S20-7: 外部群一律拒答（安全不变量）', async () => {
    const rec = recorder()
    const out = await handleBotEvent(ctx.db, group('fs_zhang', 'oc_ext', '@bot 我的项目', { external: true }), { llm: scriptedLlm().llm, send: rec.send, secret: SECRET })
    expect(out.result).toBe('refused_external')
    expect(rec.sent).toHaveLength(0)
  })

  it('S20-8: 牵头人群内登记项目 → 确认卡 → 渠道生效 cursor=登记时刻；普通成员被拒', async () => {
    const p = await mkProject('客户E系统', ctx.members.lead.id)
    // 普通成员发起 → 权限拒绝文案
    const { llm: devLlm } = scriptedLlm(
      JSON.stringify({ action: 'write', kind: 'bind_channel', payload: { projectId: p.id, chatName: '客户E项目群' } })
    )
    const devRec = recorder()
    const devOut = await handleBotEvent(ctx.db, group('fs_li', 'oc_bind', `@bot 这是「客户E系统」的群`), { llm: devLlm, send: devRec.send, secret: SECRET })
    expect(devOut.result).toBe('refused_permission')
    expect(devRec.sent[0].text).toContain('牵头人')

    // 牵头人发起 → 确认卡 → 确认后 channels 生效
    const { llm } = scriptedLlm(
      JSON.stringify({ action: 'query', sql: `SELECT id, name FROM projects WHERE name LIKE '%客户E%'` }),
      JSON.stringify({ action: 'write', kind: 'bind_channel', payload: { projectId: p.id, chatName: '客户E项目群' } })
    )
    const rec = recorder()
    const out = await handleBotEvent(ctx.db, group('fs_zhang', 'oc_bind', '@bot 这是「客户E系统」的群'), { llm, send: rec.send, secret: SECRET })
    expect(out.result).toBe('card_sent')
    const btn = rec.sent[0].card.elements.find((e) => e.tag === 'action').actions[0]
    expect(btn.value.a).toBe('bind')

    const before = Math.floor(Date.now() / 1000)
    const ok = await handleCardAction(ctx.db, { operatorOpenId: 'fs_zhang', value: btn.value, chatId: 'oc_bind', messageId: nextMsgId() }, { send: recorder().send, secret: SECRET })
    expect(ok.result).toBe('confirmed')
    const ch = ctx.db.prepare(`SELECT * FROM channels WHERE platform = 'feishu' AND group_key = 'oc_bind'`).get()
    expect(ch.project_id).toBe(p.id)
    expect(ch.channel_type).toBe('dedicated')
    expect(Number(ch.cursor)).toBeGreaterThanOrEqual(before) // 只抽取登记之后的聊天
  })

  it('S20-9: 未登记群问答可用（无默认上下文）；关闭开关后拒答', async () => {
    const p = await mkProject('客户F系统', ctx.members.lead.id)
    const { llm, calls } = scriptedLlm(
      JSON.stringify({ action: 'query', sql: `SELECT COUNT(*) AS n FROM tasks WHERE project_id = ${p.id} AND status != 'done'` }),
      JSON.stringify({ action: 'reply', text: '客户F系统还有若干未完成任务。' })
    )
    const rec = recorder()
    const out = await handleBotEvent(ctx.db, group('fs_li', 'oc_free', `@bot ${p.name} 现在有哪些未完成任务`), { llm, send: rec.send, secret: SECRET })
    expect(out.result).toBe('replied')
    expect(calls[0][0].content).toContain('未登记项目群')
    expect(rec.sent[0].text).toContain('客户F系统')

    setSetting(ctx.db, 'im.feishu', { answerUnregisteredGroups: false }, 1)
    const rec2 = recorder()
    const out2 = await handleBotEvent(ctx.db, group('fs_li', 'oc_free2', '@bot 随便问个问题'), { llm: scriptedLlm().llm, send: rec2.send, secret: SECRET })
    expect(out2.result).toBe('refused_unregistered')
    expect(rec2.sent).toHaveLength(0)
    setSetting(ctx.db, 'im.feishu', { answerUnregisteredGroups: true }, 1)
  })

  it('S20-11: /bind 仅私聊有效，群里引导去私聊', async () => {
    const rec = recorder()
    const out = await handleBotEvent(ctx.db, group('fs_li', 'oc_g2', '/bind 123456'), { send: rec.send, secret: SECRET })
    expect(out.result).toBe('replied')
    expect(rec.sent[0].text).toContain('私聊')
    // 群里没有发生绑定
    expect(ctx.db.prepare(`SELECT feishu_id FROM members WHERE id = ${ctx.members.dev.id}`).get().feishu_id).toBe('fs_li')
  })
})

describe('S20 机器人指令通道 — 对抗与边界（护栏/循环/写校验）', () => {
  it('query 工具护栏与 Agent SQL 端点同源：DDL/凭据列/sessions/裸 date(now)/写语句全拒', async () => {
    const rejects = (sql, word) => {
      try {
        runReadOnlyQuery(ctx.db, sql)
        throw new Error(`应当被拒: ${sql}`)
      } catch (e) {
        expect(e.statusCode).toBeDefined()
        expect(e.message).toContain(word)
      }
    }
    rejects('DROP TABLE members', 'DDL/PRAGMA')
    rejects('SELECT password_hash FROM members LIMIT 1', '凭据列')
    rejects("SELECT * FROM sessions", 'sessions')
    rejects("SELECT date('now')", 'BJ_TODAY')
    rejects(`INSERT INTO pushes (push_type) VALUES ('test')`, '只读查询')
    rejects('UPDATE tasks SET status = \'done\'', '只读查询')
    // 注释前缀不能绕过：-- 注释 + 写语句仍拒
    rejects('-- harmless\nDELETE FROM tasks', '只读查询')
    // 合法只读放行（含 BJ_TODAY 与注释前缀 SELECT）
    const ok = runReadOnlyQuery(ctx.db, `-- 查一下\nSELECT COUNT(*) AS n FROM tasks WHERE plan_end_date < BJ_TODAY()`)
    expect(ok.count).toBe(1)
  })

  it('agent 循环边界：坏 JSON 降级、未知动作纠偏、查询超预算、轮数耗尽、clarify 归类', async () => {
    const noop = async () => '工具结果'
    // 坏 JSON（破碎、以 { 开头）→ 降级话术（非 JSON 散文的透出见 S20-21 用例）
    const r1 = await runAgentLoop({ llm: { name: 'f', complete: async () => '{"action":"reply","text":"半截' }, systemPrompt: 's', userText: 'u', execTool: noop })
    expect(r1.result).toBe('replied')
    expect(r1.text).toContain('没听懂')
    // 未知动作 → 纠偏后 reply
    const r2 = await runAgentLoop({
      llm: { name: 'f', complete: async (m) => (m.length <= 2 ? '{"action":"dance"}' : '{"action":"reply","text":"好了"}') },
      systemPrompt: 's', userText: 'u', execTool: noop,
    })
    expect(r2.text).toBe('好了')
    // 查询超预算：第 9 次 query 被拦并要求直接回复
    let q = 0
    const r3 = await runAgentLoop({
      llm: {
        name: 'f',
        complete: async (m) => (m[m.length - 1].content.includes('上限') ? '{"action":"reply","text":"查够了"}' : '{"action":"query","sql":"SELECT 1"}'),
      },
      systemPrompt: 's', userText: 'u', execTool: async () => { q += 1; return '[]' }, maxTurns: 12,
    })
    expect(q).toBe(8)
    expect(r3.text).toBe('查够了')
    // 轮数耗尽 → 兜底话术
    const r4 = await runAgentLoop({
      llm: { name: 'f', complete: async () => '{"action":"query","sql":"SELECT 1"}' },
      systemPrompt: 's', userText: 'u', execTool: noop, maxTurns: 3,
    })
    expect(r4.text).toContain('太多')
    // clarify → clarified
    const r5 = await runAgentLoop({ llm: { name: 'f', complete: async () => '{"action":"clarify","text":"你指哪个项目？"}' }, systemPrompt: 's', userText: 'u', execTool: noop })
    expect(r5.result).toBe('clarified')
  })

  // S20-21（v0.38）LLM 偶发不守 JSON 协议的分层降级：线上实测（真实凭证+真实系统提示全链路复现）
  // GLM-5.3-Flash 多轮工具调用后想向用户澄清时直接输出中文散文（内容正确、就是要给用户看的话），
  // 此前 parseJsonLoose 失败一律回「没听懂」——用户收到驴唇不对马嘴的回复。
  it('S20-21: 非 JSON 散文/缺 action 的半成品 JSON 透出为答复；空输出与破碎 JSON 维持没听懂', async () => {
    const noop = async () => '工具结果'
    // ① 纯散文（线上复现原文形态：多轮查询后向用户提问澄清）→ 原样透出
    const prose = '已核对现有配置，起草立项提议前需确认几点：\n\n1. 项目类型：当前启用的类型有 365连麦、1v1商业咨询…\n2. 牵头人：默认写斯斯（id=1）？\n\n确认后我立即起草立项提议。'
    const r1 = await runAgentLoop({ llm: { name: 'f', complete: async () => prose }, systemPrompt: 's', userText: 'u', execTool: noop })
    expect(r1.kind).toBe('reply')
    expect(r1.result).toBe('replied')
    expect(r1.text).toBe(prose)
    // ② 缺 action 但带非空 text 的半成品 JSON → 透出 text
    const r2 = await runAgentLoop({ llm: { name: 'f', complete: async () => '{"text":"建议先确认项目类型再立项。"}' }, systemPrompt: 's', userText: 'u', execTool: noop })
    expect(r2.result).toBe('replied')
    expect(r2.text).toBe('建议先确认项目类型再立项。')
    // ③ 空输出 → 没听懂
    const r3 = await runAgentLoop({ llm: { name: 'f', complete: async () => '' }, systemPrompt: 's', userText: 'u', execTool: noop })
    expect(r3.text).toContain('没听懂')
    // ④ 破碎 JSON（以 { 开头解析失败）→ 没听懂
    const r4 = await runAgentLoop({ llm: { name: 'f', complete: async () => '{"action":"query","sql":"SELECT' }, systemPrompt: 's', userText: 'u', execTool: noop })
    expect(r4.text).toContain('没听懂')
    // ⑤ 缺 action 且无 text 的 JSON → 没听懂（不透出对象字符串）
    const r5 = await runAgentLoop({ llm: { name: 'f', complete: async () => '{"foo":1}' }, systemPrompt: 's', userText: 'u', execTool: noop })
    expect(r5.text).toContain('没听懂')
    // ⑥ 透出发生在工具调用之后时 turns/queries 照实计数
    let n = 0
    const r6 = await runAgentLoop({
      llm: { name: 'f', complete: async () => (n++ === 0 ? '{"action":"query","sql":"SELECT 1"}' : prose) },
      systemPrompt: 's', userText: 'u', execTool: async () => '[{"n":1}]',
    })
    expect(r6.text).toBe(prose)
    expect(r6.turns).toBe(2)
    expect(r6.queries).toBe(1)
  })

  it('S20-21: 私聊全链路——首轮查询后模型散文澄清，用户收到澄清原文而非「没听懂」；系统提示含裸文本禁令', async () => {
    const prose = '起草立项提议前需确认：1. 项目类型选哪个？2. 牵头人默认是你吗？'
    const { llm, calls } = scriptedLlm(
      JSON.stringify({ action: 'query', sql: 'SELECT id, code, name FROM project_types WHERE status = \'active\'' }),
      prose,
    )
    const rec = recorder()
    // 独立 chatId：避免本用例消息混入 oc_p2p 共享会话历史、干扰其他用例的上下文断言
    const evt = { ...p2p('fs_zhang', '新建一个项目：问问斯斯上线前准备项目'), chatId: 'oc_s2021' }
    const out = await handleBotEvent(ctx.db, evt, { llm, send: rec.send, secret: SECRET })
    expect(out.result).toBe('replied')
    expect(rec.sent[0].text).toBe(prose)
    // 系统提示加固：裸文本禁令进协议头
    expect(calls[0][0].content).toContain('不输出裸文本')
  })

  it('写分发校验：非法载荷一律拒绝并给中文理由，不落库', async () => {
    const p = await mkProject('客户H系统', ctx.members.lead.id)
    const taskId = ctx.db.prepare('SELECT id FROM tasks WHERE project_id = ? ORDER BY id').get(p.id).id
    const member = { id: ctx.members.lead.id, name: '张三', role: 'member' }
    const evt = { chatType: 'p2p', messageId: 'om_w', text: '原始消息', ts: Date.now() }
    const refuse = async (kind, payload, word) => {
      const r = await runWriteTool(ctx.db, { kind, payload }, { member, evt })
      expect(r.type).toBe('refused')
      expect(r.text).toContain(word)
    }
    await refuse('record_event', {}, 'projectId')
    await refuse('record_event', { projectId: p.id, eventType: 'progress' }, 'summary')
    await refuse('record_event', { projectId: 999999, eventType: 'progress', summary: 'x' }, 'projectId')
    await refuse('record_event', { projectId: p.id, eventType: '不存在的类型', summary: 'x' }, '操作被拒绝')
    await refuse('suggest_event', { targetTaskId: 999999, targetField: 'status', targetValue: 'done' }, 'targetTaskId')
    await refuse('suggest_event', { targetTaskId: taskId, targetField: 'nope', targetValue: 'x' }, 'targetField')
    await refuse('suggest_event', { targetTaskId: taskId, targetField: 'plan_end_date', targetValue: '明天' }, 'YYYY-MM-DD')
    await refuse('suggest_event', { targetTaskId: taskId, targetField: 'responsible_member_id', targetValue: 999 }, '在职成员')
    await refuse('suggest_event', { targetTaskId: taskId, targetField: 'status', targetValue: '完成后', projectId: p.id + 1 }, '任务不属于')
    await refuse('bind_channel', { projectId: p.id }, '群聊') // 私聊里不可登记
    await refuse('trigger', { name: 'put_setting' }, '仅支持') // 白名单外（配置类不开放给机器人）
    await refuse('magic', {}, '不支持的写类型')
    // 权限：普通成员（非牵头人/管理员）bind_channel 在群里 → refused_permission
    const nobody = { id: ctx.members.dev.id, name: '李四', role: 'member' }
    const denied = await runWriteTool(ctx.db, { kind: 'bind_channel', payload: { projectId: p.id } }, { member: nobody, evt: { ...evt, chatType: 'group' } })
    expect(denied.result).toBe('refused_permission')
  })

  it('trigger 工具走 action 注册表（与 HTTP 端点同构）', async () => {
    const r = await runWriteTool(ctx.db, { kind: 'trigger', payload: { name: 'generate_person_digest', params: { memberId: ctx.members.lead.id } } },
      { member: { id: ctx.members.lead.id, name: '张三', role: 'member' }, evt: { chatType: 'p2p' } })
    expect(r.type).toBe('receipt')
    expect(r.text).toContain('generate_person_digest')
  })

  it('卡片回调边界：未知动作 / 无密钥 / 项目已删', async () => {
    const unknown = await handleCardAction(ctx.db, { operatorOpenId: 'fs_zhang', value: { a: 'magic' }, chatId: 'c' }, { send: recorder().send, secret: SECRET })
    expect(unknown.result).toBe('error')
    const noSecret = await handleCardAction(ctx.db, { operatorOpenId: 'fs_zhang', value: { a: 'confirm', e: '1', s: 'x' }, chatId: 'c' }, { send: recorder().send, secret: '' })
    expect(noSecret.text).toContain('签名密钥')
    const goneCard = buildBindCard({ projectId: 999999, projectName: '幽灵项目', chatId: 'oc_x', chatName: '' }, SECRET)
    const gone = await handleCardAction(ctx.db, {
      operatorOpenId: 'fs_zhang',
      value: goneCard.elements.find((e) => e.tag === 'action').actions[0].value,
      chatId: 'c',
    }, { send: recorder().send, secret: SECRET })
    expect(gone.text).toContain('项目已不存在')
  })
})

describe('S20 机器人指令通道 — 审计、限额与去重', () => {
  it('S20-5: message_id 去重 + 每日限额（北京日）', async () => {
    // 同文件共享库：先清李四当日指令行，让限额从 0 起算（验证配额语义本身）
    ctx.db.prepare('DELETE FROM bot_commands WHERE member_id = ?').run(ctx.members.dev.id)
    setSetting(ctx.db, 'im.feishu', { commandQuotaPerDay: 1 }, 1)
    const { llm } = scriptedLlm(JSON.stringify({ action: 'reply', text: '好的' }))
    const rec = recorder()
    const evt = p2p('fs_li', '在吗')
    const out1 = await handleBotEvent(ctx.db, evt, { llm, send: rec.send, secret: SECRET })
    expect(out1.result).toBe('replied')
    // 同一 message_id 重复投递 → 忽略，无二次回复
    const out1b = await handleBotEvent(ctx.db, evt, { llm, send: rec.send, secret: SECRET })
    expect(out1b.result).toBe('ignored_dedup')
    expect(rec.sent).toHaveLength(1)
    // 限额=1：第二条拒绝
    const out2 = await handleBotEvent(ctx.db, p2p('fs_li', '再问一条'), { llm: scriptedLlm().llm, send: rec.send, secret: SECRET })
    expect(out2.result).toBe('refused_quota')
    expect(rec.sent[1].text).toContain('额度')
    setSetting(ctx.db, 'im.feishu', { commandQuotaPerDay: 50 }, 1)
    expect(getSetting(ctx.db, 'im.feishu').commandQuotaPerDay).toBe(50)
  })

  it('S20-5: 限额口径只计 IM 面——web 会话消息不烧飞书额度（v0.25 对称）', async () => {
    // 同文件共享库：清李四当日指令行，从 0 起算
    ctx.db.prepare('DELETE FROM bot_commands WHERE member_id = ?').run(ctx.members.dev.id)
    setSetting(ctx.db, 'im.feishu', { commandQuotaPerDay: 2 }, 1)
    // 真实路径造 3 条 web 指令审计行（LLM 未配置 → no_llm，审计行照落）
    const cookie = await loginCookie(ctx.app, 'lisi', 'pass-123456')
    const sid = (await authed(ctx.app, cookie, 'POST', '/api/v1/chat/sessions', {})).body.id
    for (let i = 0; i < 3; i++) {
      await authed(ctx.app, cookie, 'POST', `/api/v1/chat/sessions/${sid}/messages`, { text: `web 第 ${i + 1} 条` })
    }
    expect(ctx.db.prepare(`SELECT COUNT(*) AS n FROM bot_commands WHERE member_id = ? AND platform = 'web' AND kind = 'command'`).get(ctx.members.dev.id).n).toBe(3)
    // 飞书第 1 条：若口径未修（web 也计入），3 + 1 > 2 会被拒
    const { llm } = scriptedLlm(JSON.stringify({ action: 'reply', text: '好的' }))
    const rec = recorder()
    const out = await handleBotEvent(ctx.db, p2p('fs_li', '在吗'), { llm, send: rec.send, secret: SECRET })
    expect(out.result).toBe('replied')
    setSetting(ctx.db, 'im.feishu', { commandQuotaPerDay: 50 }, 1)
  })

  it('S20-10: 定时抽取跳过机器人已处理的消息（不双入库）', async () => {
    const p = await mkProject('客户G系统', ctx.members.lead.id)
    const ch = upsertChannel(ctx.db, { platform: 'feishu', groupKey: 'oc_g_sys', channelType: 'dedicated', projectId: p.id })
    // 机器人已把这条消息处理成记录型事件
    const { llm } = scriptedLlm(
      JSON.stringify({ action: 'write', kind: 'record_event', payload: { projectId: p.id, eventType: 'risk', summary: '联调阻塞' } })
    )
    const evt10 = group('fs_zhang', 'oc_g_sys', '@bot 登记风险：联调阻塞', { chatTitle: 'G群' })
    const out = await handleBotEvent(ctx.db, evt10, { llm, send: recorder().send, secret: SECRET })
    expect(out.result).toBe('replied')
    const before = ctx.db.prepare('SELECT COUNT(*) AS n FROM project_events WHERE project_id = ?').get(p.id).n
    // 同一 message_id 走定时抽取 → 跳过（即使抽取器想产事件）
    const extractLlm = { name: 'fake', complete: async () => JSON.stringify({ events: [{ nature: 'record', eventType: 'progress', summary: '重复', confidence: 0.9 }] }) }
    const stats = await ingestMessages(ctx.db, ch, [{ id: evt10.messageId, speakerId: 'fs_zhang', text: '@bot 登记风险：联调阻塞', ts: Date.now() }], { llm: extractLlm })
    expect(stats.botProcessed).toBe(1)
    expect(stats.events).toBe(0)
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM project_events WHERE project_id = ?').get(p.id).n).toBe(before)
  })
})

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
    const p = await mkProject('客户P系统', ctx.members.lead.id)
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
    // 水位线：窗口内新对话，/new 后 → 空
    const c4 = 'oc_u4'
    seedTurn(c4, {})
    ctx.db.prepare(`INSERT INTO bot_context_resets (platform, chat_id, member_id, message_id, cleared_at) VALUES ('feishu', ?, 1, 'om_r', ?)`).run(c4, Date.now())
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

// 网关接线层：SDK 真实载荷形态（1.74 官方 README：EventDispatcher 直接传入解包后 {sender, message}）。
// 此前 gateway 只取 data.event.message 恒为空，所有入站消息在审计落库前被静默丢弃——线上实测暴露的盲区。
describe('S20 网关事件载荷解析', () => {
  it('SDK 解包形态 {sender, message} 正确映射（线上实测形态，修复回归锚点）', () => {
    const r = parseSdkMessage({
      sender: { sender_id: { open_id: 'ou_x' }, sender_type: 'user' },
      message: { message_id: 'om_1', chat_id: 'oc_1', chat_type: 'p2p', message_type: 'text', content: '{"text":"你好"}' },
    })
    expect(r.msg.message_id).toBe('om_1')
    expect(r.msg.message_type).toBe('text')
    expect(r.senderOpenId).toBe('ou_x')
  })

  it('event 包络形态（{event:{sender,message}}）同样兼容', () => {
    const r = parseSdkMessage({ event: { sender: { sender_id: { open_id: 'ou_y' } }, message: { message_id: 'om_2', message_type: 'text' } } })
    expect(r.msg.message_id).toBe('om_2')
    expect(r.senderOpenId).toBe('ou_y')
  })

  it('空载荷不抛错，返回空对象由调用方按非 text 过滤', () => {
    const r = parseSdkMessage({})
    expect(r.msg).toEqual({})
    expect(r.senderOpenId).toBe('')
  })
})

// S20-20（v0.37）富文本（post）消息拍平：飞书输入框把 "- " 列表行/粘贴格式自动转 post，此前网关
// 只认 text，此类消息在审计落库前被静默丢弃（线上实测：多行带列表的立项指令零回复零痕迹）。
describe('S20-20 网关富文本（post）消息拍平', () => {
  // 2026-10-08 线上真实载荷（om_x100b6340207db5b…，飞书消息历史 API 原样）：
  // "- " 前缀被拆为独立 text 元素，段间空段落，title 为空串
  const REAL_POST_CONTENT = JSON.stringify({
    title: '',
    content: [
      [{ tag: 'text', text: '新建一个项目：问问斯斯上线前准备项目', style: [] }],
      [],
      [{ tag: 'text', text: '目前列进去的工作项：', style: [] }],
      [],
      [{ tag: 'text', text: '- ', style: [] }, { tag: 'text', text: '私董专区内容 - 下午茶上传', style: [] }],
      [{ tag: 'text', text: '- ', style: [] }, { tag: 'text', text: '私董专区内容 - 更新内训播放时长', style: [] }],
    ],
  })

  it('S20-20: 线上真实 post 载荷拍平为原文（段内元素直连、段落换行连接、空段落成空行）', () => {
    expect(extractMessageText('post', REAL_POST_CONTENT)).toBe(
      '新建一个项目：问问斯斯上线前准备项目\n\n目前列进去的工作项：\n\n- 私董专区内容 - 下午茶上传\n- 私董专区内容 - 更新内训播放时长'
    )
  })

  it('S20-20: text 原样；post 的 @元素渲染 @名字（缺省 @用户）、链接取锚文本、图片 [图片] 占位、非空 title 置顶', () => {
    expect(extractMessageText('text', JSON.stringify({ text: '你好' }))).toBe('你好')
    const post = JSON.stringify({
      title: '会议纪要',
      content: [
        [{ tag: 'text', text: '转给' }, { tag: 'at', user_id: 'ou_9', user_name: '李四' }, { tag: 'text', text: ' 处理' }],
        [{ tag: 'a', text: '参考文档', href: 'https://x' }, { tag: 'img', image_key: 'k' }],
        [{ tag: 'at', user_id: 'ou_8' }],
      ],
    })
    expect(extractMessageText('post', post)).toBe('会议纪要\n转给@李四 处理\n参考文档[图片]\n@用户')
  })

  it('S20-20: 非法 content、无段落与其余消息类型（图片/文件/语音等）返回空串，由网关静默忽略', () => {
    expect(extractMessageText('post', 'not-json')).toBe('')
    expect(extractMessageText('post', JSON.stringify({ title: '', content: [] }))).toBe('')
    expect(extractMessageText('image', JSON.stringify({ image_key: 'k' }))).toBe('')
    expect(extractMessageText('text', JSON.stringify({}))).toBe('')
    // 纯空白段落拍平出 \n（非空串）——由网关既有 trim 空判定静默忽略，与旧行为一致
    expect(extractMessageText('post', JSON.stringify({ title: '', content: [[], []] }))).toBe('\n')
  })

  it('S20-20: post 私聊指令拍平后进管线——LLM 收到拍平文本、审计原文=拍平文本、照常回复', async () => {
    const { llm, calls } = scriptedLlm(
      JSON.stringify({ action: 'query', sql: 'SELECT COUNT(*) AS n FROM projects' }),
      JSON.stringify({ action: 'reply', text: '已了解，准备起草立项提议。' })
    )
    const rec = recorder()
    const evt = p2p('fs_zhang', extractMessageText('post', REAL_POST_CONTENT))
    const out = await handleBotEvent(ctx.db, evt, { llm, send: rec.send, secret: SECRET })
    expect(out.result).toBe('replied')
    expect(rec.sent[0].text).toContain('立项提议')
    // LLM 收到的用户消息 = 拍平文本（多行与 "- " 列表行保留；messages 数组随循环按引用追加、共享库带前序
    // 测试会话历史，按列表行内容定位本项目消息）
    const userMsg = calls[0].find((m) => m.role === 'user' && m.content.includes('私董专区内容 - 下午茶上传')).content
    expect(userMsg).toContain('新建一个项目：问问斯斯上线前准备项目')
    expect(userMsg).toContain('\n- 私董专区内容 - 下午茶上传')
    // 审计原文 = 拍平文本
    const row = botRow(evt.messageId)
    expect(row.raw_text).toContain('- 私董专区内容 - 更新内训播放时长')
  })
})

// 出站连接器回归锚点：receive_id_type 合法值为 chat_id（此前误传消息拉取接口的 'chat'，
// 飞书拒参导致所有机器人回复/卡片发送失败——线上实测暴露，globalThis.fetch 注桩同 S22 手法）。
describe('S20 机器人出站发送', () => {
  it('sendText/sendCard 以 receive_id_type=chat_id 调用发送接口', async () => {
    const real = globalThis.fetch
    const urls = []
    globalThis.fetch = async (url, opts = {}) => {
      const u = String(url)
      urls.push(u + ' ' + String(opts?.method || 'GET'))
      if (u.includes('/auth/v3/tenant_access_token')) return new Response(JSON.stringify({ code: 0, tenant_access_token: 't-1' }), { status: 200 })
      if (u.includes('/im/v1/messages') && opts?.method === 'POST') {
        return new Response(JSON.stringify({ code: 0, data: { message_id: 'om_out_1' } }), { status: 200 })
      }
      throw new Error('unexpected fetch: ' + u)
    }
    try {
      const cfg = { appId: 'cli_x', appSecret: 's' }
      const r1 = await sendText(cfg, 'oc_test', '你好')
      const r2 = await sendCard(cfg, 'oc_test', { config: {}, elements: [] })
      expect(r1.messageId).toBe('om_out_1')
      expect(r2.messageId).toBe('om_out_1')
      // 发送调用必须带 receive_id_type=chat_id（'chat' 会被飞书拒参）
      const sends = urls.filter((u) => u.includes('receive_id_type='))
      expect(sends.every((u) => u.includes('receive_id_type=chat_id'))).toBe(true)
      expect(sends).toHaveLength(2)
    } finally {
      globalThis.fetch = real
    }
  })
})

// S20-16（v0.26.1）— 群消息必须 @ 本机器人：应用持有 im:message.group_msg 时事件推送为
// 群内全部消息，此前网关只剥 @ 前缀不校验对象，普通聊天被当成指令 → 机器人主动搭话（线上实测）。
describe('S20 群 @ 判定（refused_not_mentioned）', () => {
  it('S20-16: 未 @ 机器人（mentioned=false）的群消息一律忽略——不回复、不进 LLM、留审计', async () => {
    const rec = recorder()
    const evt = group('fs_zhang', 'oc_g_mention', '今天中午吃什么')
    const out = await handleBotEvent(ctx.db, { ...evt, mentioned: false }, { llm: scriptedLlm().llm, send: rec.send, secret: SECRET })
    expect(out.result).toBe('refused_not_mentioned')
    expect(rec.sent).toHaveLength(0)
    const row = botRow(evt.messageId)
    expect(row.result).toBe('refused_not_mentioned')
    expect(row.llm_calls).toBeNull()
    // 不产任何事件
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM project_events WHERE summary LIKE ?').get('%中午吃什么%').n).toBe(0)

    // @ 了机器人（mentioned=true）不受影响：正常走门禁链
    const rec2 = recorder()
    const evt2 = group('fs_zhang', 'oc_g_mention', '@bot 在吗', { chatTitle: 'M群' })
    const out2 = await handleBotEvent(ctx.db, { ...evt2, mentioned: true }, { llm: scriptedLlm(JSON.stringify({ action: 'reply', text: '在的' })).llm, send: rec2.send, secret: SECRET })
    expect(out2.result).toBe('replied')
    expect(rec2.sent[0].text).toBe('在的')
    // 未带 mentioned 字段（私聊/旧调用方）不判定，兼容既有契约
    const out3 = await handleBotEvent(ctx.db, p2p('fs_zhang', '私聊不受影响'), { llm: scriptedLlm(JSON.stringify({ action: 'reply', text: '好的' })).llm, send: recorder().send, secret: SECRET })
    expect(out3.result).toBe('replied')
  })

  it('S20-16: resolveMention——mentions 比对机器人 open_id；身份缺失降级要求 @_user_N 前缀；私聊恒真', async () => {
    const { resolveMention } = await import('../brain/bot/gateway.js')
    const BOT = 'ou_bot_1'
    const M = (openId) => [{ key: '@_user_1', id: { open_id: openId } }]
    expect(resolveMention({ chatType: 'p2p', mentions: [], rawText: '你好' })).toBe(true) // 私聊不判定
    expect(resolveMention({ chatType: 'group', mentions: M(BOT), rawText: '@_user_1 在吗', botOpenId: BOT })).toBe(true)
    expect(resolveMention({ chatType: 'group', mentions: M('ou_member_9'), rawText: '@_user_1 帮我问下小王', botOpenId: BOT })).toBe(false) // @ 的是别人
    expect(resolveMention({ chatType: 'group', mentions: [], rawText: '今天中午吃什么', botOpenId: BOT })).toBe(false) // 无 @
    expect(resolveMention({ chatType: 'group', mentions: [...M('ou_member_9'), { key: '@_user_2', id: { open_id: BOT } }], rawText: '@_user_1 帮我 @机器人 在吗', botOpenId: BOT })).toBe(true) // 顺带 @ 到机器人也算
    // 身份获取失败降级：带占位前缀放行（交给后续门禁），无前缀忽略
    expect(resolveMention({ chatType: 'group', mentions: M('ou_member_9'), rawText: '@_user_1 在吗', botOpenId: null })).toBe(true)
    expect(resolveMention({ chatType: 'group', mentions: [], rawText: '随便聊聊', botOpenId: null })).toBe(false)
  })
})

// —— v0.34：任务盘点 /tasks（S20-17）与群讨论上下文 recent_chat（S20-18）——
// 同文件共享库：S20-5 会把当日限额设回 50，这里在各自 describe 内抬高（describe 级 beforeAll 晚于 S20-5 执行），避免撞 refused_quota

describe('S20 机器人指令通道 — 任务盘点 /tasks（v0.34）', () => {
  beforeAll(() => setSetting(ctx.db, 'im.feishu', { commandQuotaPerDay: 500 }, 1))

  it('S20-17: 专题群 /tasks——本项目全部未完任务，未分配责任人置顶+计数；已完成无主任务不出现（零 LLM，别名等价）', async () => {
    const p = await mkProject('盘点甲项目', ctx.members.lead.id)
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
    const pa = await mkProject('盘点乙项目', ctx.members.lead.id)
    const pb = await mkProject('盘点丙项目', ctx.members.lead.id)
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
    const p = await mkProject('盘点丁项目', ctx.members.lead.id)
    ctx.db.prepare(`UPDATE tasks SET responsible_member_id = NULL, plan_start_date = NULL, plan_end_date = NULL WHERE id = (SELECT id FROM tasks WHERE project_id = ? ORDER BY id LIMIT 1)`).run(p.id)
    const scoped = tasksInventory(ctx.db, { projectId: p.id })
    expect(scoped.text).toContain('未分配责任人 1 条')
    const globalInv = tasksInventory(ctx.db, {})
    expect(globalInv.text).toContain('盘点丁项目')
  })
})

describe('S20 机器人指令通道 — 群讨论上下文 recent_chat（v0.34）', () => {
  beforeAll(() => setSetting(ctx.db, 'im.feishu', { commandQuotaPerDay: 500 }, 1))

  it('S20-18: 专题群 recent_chat 拉最近讨论——回看窗/尾条数/说话人映射/机器人消息过滤/不挪游标不产事件', async () => {
    const p = await mkProject('讨论甲项目', ctx.members.lead.id)
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
  beforeAll(() => setSetting(ctx.db, 'im.feishu', { commandQuotaPerDay: 500 }, 1))

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
    const p = await mkProject('占位甲项目', ctx.members.lead.id)
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
    const p = await mkProject('占位乙项目', ctx.members.lead.id)
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
