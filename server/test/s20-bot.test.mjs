import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupApp, loginCookie, authed } from './helpers.mjs'
import { upsertChannel } from '../engine/tasks.js'
import { ingestMessages } from '../brain/extract.js'
import { handleBotEvent, handleCardAction, issueBindCode, buildBindCard } from '../brain/bot/command.js'
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

const recorder = () => {
  const sent = []
  return { sent, send: async (m) => { sent.push(m); return { messageId: `bot_${sent.length}` } } }
}

const p2p = (openId, text) => ({ messageId: nextMsgId(), chatId: 'oc_p2p', chatType: 'p2p', senderOpenId: openId, text, ts: Date.now() })
const group = (openId, chatId, text, extra = {}) => ({ messageId: nextMsgId(), chatId, chatType: 'group', senderOpenId: openId, text, ts: Date.now(), ...extra })

async function mkProject(name, leadId) {
  const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
  const res = await authed(ctx.app, cookie, 'POST', '/api/v1/projects', {
    name, templateCode: 'software_delivery', leadMemberId: leadId, planEndDate: '2026-12-31',
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
  it('S20-2: 口述变更 → pending 建议 + 确认卡；责任人确认生效留痕；无权者/伪造签名被拒', async () => {
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

    // 无权者（李四：非责任人/非牵头人/非管理员）点确认 → 拒，事件仍 pending
    const denied = await handleCardAction(ctx.db, { operatorOpenId: 'fs_li', value: confirmBtn.value, chatId: 'oc_p2p', messageId: nextMsgId() }, { send: recorder().send, secret: SECRET })
    expect(denied.result).toBe('refused_permission')
    expect(ctx.db.prepare('SELECT status FROM project_events WHERE id = ?').get(evtRow.id).status).toBe('pending')

    // 伪造签名 → 拒
    const forged = await handleCardAction(ctx.db, { operatorOpenId: 'fs_zhang', value: { ...confirmBtn.value, s: 'deadbeef' }, chatId: 'oc_p2p', messageId: nextMsgId() }, { send: recorder().send, secret: SECRET })
    expect(forged.result).toBe('error')

    // 责任人（张三=默认责任人）确认 → 生效、留痕
    const okRec = recorder()
    const ok = await handleCardAction(ctx.db, { operatorOpenId: 'fs_zhang', value: confirmBtn.value, chatId: 'oc_p2p', messageId: nextMsgId() }, { send: okRec.send, secret: SECRET })
    expect(ok.result).toBe('confirmed')
    expect(okRec.sent[0].text).toContain('已生效')
    const after = ctx.db.prepare('SELECT status, decided_by FROM project_events WHERE id = ?').get(evtRow.id)
    expect(after.status).toBe('effective')
    expect(after.decided_by).toBe(ctx.members.lead.id)
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
    // 坏 JSON → 降级话术
    const r1 = await runAgentLoop({ llm: { name: 'f', complete: async () => '不是 JSON' }, systemPrompt: 's', userText: 'u', execTool: noop })
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
