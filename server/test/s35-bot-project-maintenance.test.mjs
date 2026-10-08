import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupApp, loginCookie, authed } from './helpers.mjs'
import { handleBotEvent, handleCardAction, buildSystemPrompt } from '../brain/bot/command.js'
import { runWriteTool } from '../brain/bot/tools.js'
import { createMilestone } from '../engine/tasks.js'
import { confirmEvent } from '../engine/events.js'
import { today } from '../db/time.js'

// PRD S35（v0.39）— 机器人项目维护面补全：建任务/建里程碑/项目信息变更走提议确认卡，
// 里程碑改期/状态走建议事件；LLM 只起草不生效，确认分发回既有引擎（终态守卫/D3/审计/留痕全继承）。

const SECRET = 's35-test-bot-hmac-secret-32-bytes!'

let ctx
let seq = 0
const nextMsgId = () => `om_s35_${++seq}`

function scriptedLlm(...actions) {
  return {
    llm: {
      name: 'fake',
      complete: async () => String(actions.shift() ?? '{"action":"reply","text":"（脚本耗尽）"}'),
    },
  }
}

let replySeq = 0
const recorder = () => {
  const sent = []
  return { sent, send: async (m) => { sent.push(m); return { messageId: `bot_${++replySeq}` } } }
}

const p2p = (openId, text) => ({ messageId: nextMsgId(), chatId: 'oc_p2p', chatType: 'p2p', senderOpenId: openId, text, ts: Date.now() })

/** 写工具直调便捷封装：以某成员身份发起一次 write。 */
const write = (member, kind, payload, evt = {}) =>
  runWriteTool(ctx.db, { kind, payload }, { member, evt: { ts: Date.now(), text: '（口述原文）', ...evt } })

async function mkProject(name, leadId) {
  const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
  const res = await authed(ctx.app, cookie, 'POST', '/api/v1/projects', {
    name, templateCode: 'lianmai_365', leadMemberId: leadId, planEndDate: '2026-12-31',
  })
  return res.body
}

const proposalRow = (id) => ctx.db.prepare('SELECT * FROM proposals WHERE id = ?').get(id)

beforeAll(async () => {
  ctx = await setupApp()
})
afterAll(() => ctx?.db.close())

describe('S35 机器人项目维护面补全', () => {
  it('S35-1: add_task 提议——软校验拒绝不落库；牵头人确认生效（D3 缺省责任人 + 审计）；无权人 403；提议人可撤回；终态项目确认失败', async () => {
    const p = await mkProject('客户S35系统', ctx.members.lead.id)

    // 软校验：title 空白 / projectId 不真实 → refused，不落 proposals
    const before = ctx.db.prepare('SELECT COUNT(*) AS n FROM proposals').get().n
    const badTitle = await write(ctx.members.lead, 'propose', { kind: 'add_task', projectId: p.id, title: '  ' })
    expect(badTitle.type).toBe('refused')
    expect(badTitle.text).toContain('title')
    const badProj = await write(ctx.members.lead, 'propose', { kind: 'add_task', projectId: 99999, title: 'X' })
    expect(badProj.type).toBe('refused')
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM proposals').get().n).toBe(before)

    // 正常起草：提议 pending，任务未落库
    const out = await write(ctx.members.lead, 'propose', { kind: 'add_task', projectId: p.id, title: '365 连麦表单城市字段修复', planEndDate: '2026-10-20' })
    expect(out.type).toBe('card')
    expect(out.cardKind).toBe('propose')
    expect(out.summary).toContain('365 连麦表单城市字段修复')
    const prop = proposalRow(out.proposalId)
    expect(prop.kind).toBe('add_task')
    expect(prop.status).toBe('pending')
    const tasksOf = () => ctx.db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND title = ?').get(p.id, '365 连麦表单城市字段修复').n
    expect(tasksOf()).toBe(0)

    // 非牵头人非管理员确认 → 403；提议人自己撤回自己的提议 → rejected
    const devCookie = await loginCookie(ctx.app, 'lisi', 'pass-123456')
    const denied = await authed(ctx.app, devCookie, 'POST', `/api/v1/proposals/${out.proposalId}/confirm`, {})
    expect(denied.status).toBe(403)
    expect(tasksOf()).toBe(0)
    const own = await write(ctx.members.dev, 'propose', { kind: 'add_task', projectId: p.id, title: '李四起草的任务' })
    expect(proposalRow(own.proposalId).proposed_by).toBe(ctx.members.dev.id)
    const withdrawn = await authed(ctx.app, devCookie, 'POST', `/api/v1/proposals/${own.proposalId}/reject`, {})
    expect(withdrawn.status).toBe(200)
    expect(proposalRow(own.proposalId).status).toBe('rejected')
    // 他人（非提议人、无确认权）不可撤回
    const stranger = await authed(ctx.app, devCookie, 'POST', `/api/v1/proposals/${out.proposalId}/reject`, {})
    expect(stranger.status).toBe(403)

    // 牵头人确认 → 生效：todo / 责任人缺省=牵头人（D3）/ 审计 task.create
    const out2 = await write(ctx.members.lead, 'propose', { kind: 'add_task', projectId: p.id, title: '365 连麦表单城市字段修复', planEndDate: '2026-10-20' })
    const leadCookie = await loginCookie(ctx.app, 'zhangsan', 'pass-123456')
    const ok = await authed(ctx.app, leadCookie, 'POST', `/api/v1/proposals/${out2.proposalId}/confirm`, {})
    expect(ok.status).toBe(200)
    const task = ctx.db.prepare('SELECT * FROM tasks WHERE project_id = ? AND title = ?').get(p.id, '365 连麦表单城市字段修复')
    expect(task.status).toBe('todo')
    expect(task.responsible_member_id).toBe(ctx.members.lead.id)
    expect(task.plan_end_date).toBe('2026-10-20')
    const audited = ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'task.create' AND object_id = ?").get(String(task.id)).n
    expect(audited).toBe(1)

    // 终态项目：提议可起草，确认失败提示只读（先按 S8 清空未完任务才能结项）
    ctx.db.prepare("UPDATE tasks SET status = 'done', actual_end_date = ? WHERE project_id = ?").run(today(), p.id)
    const closed = await authed(ctx.app, leadCookie, 'POST', `/api/v1/projects/${p.id}/close`, { summary: 'S35 结项用例' })
    expect(closed.status).toBe(200)
    const out3 = await write(ctx.members.lead, 'propose', { kind: 'add_task', projectId: p.id, title: '结项后的任务' })
    const late = await authed(ctx.app, leadCookie, 'POST', `/api/v1/proposals/${out3.proposalId}/confirm`, {})
    expect(late.status).toBe(409)
    expect(late.body.message).toContain('只读')
  })

  it('S35-2: update_project 提议——无字段/非法优先级/改 status 拒绝；确认生效走 updateProject 同一校验留痕', async () => {
    const p = await mkProject('客户S35B系统', ctx.members.lead.id)

    // 拒绝三连：无变更字段 / 非法优先级 / 试图改 status（S29）
    const noFields = await write(ctx.members.lead, 'propose', { kind: 'update_project', projectId: p.id })
    expect(noFields.type).toBe('refused')
    const badPriority = await write(ctx.members.lead, 'propose', { kind: 'update_project', projectId: p.id, priority: 'urgent' })
    expect(badPriority.type).toBe('refused')
    const withStatus = await write(ctx.members.lead, 'propose', { kind: 'update_project', projectId: p.id, status: 'closed' })
    expect(withStatus.type).toBe('refused')
    expect(withStatus.text).toContain('结项')
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM proposals WHERE kind = 'update_project'").get().n).toBe(0)

    // 正常起草 + 确认：优先级与客户名生效、优先级变更落事件、审计可查
    const out = await write(ctx.members.lead, 'propose', { kind: 'update_project', projectId: p.id, priority: 'high', clientName: '新客户名' })
    expect(out.type).toBe('card')
    expect(out.summary).toContain('客户S35B系统')
    const leadCookie = await loginCookie(ctx.app, 'zhangsan', 'pass-123456')
    const ok = await authed(ctx.app, leadCookie, 'POST', `/api/v1/proposals/${out.proposalId}/confirm`, {})
    expect(ok.status).toBe(200)
    const after = ctx.db.prepare('SELECT priority, client_name FROM projects WHERE id = ?').get(p.id)
    expect(after.priority).toBe('high')
    expect(after.client_name).toBe('新客户名')
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM project_events WHERE project_id = ? AND event_type = 'priority_change'").get(p.id).n).toBeGreaterThanOrEqual(1)
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'project.update' AND object_id = ?").get(String(p.id)).n).toBeGreaterThanOrEqual(1)
  })

  it('S35-3: update_project 换牵头人——web PATCH 同通道生效并落 owner_change；不在职牵头人起草即拒', async () => {
    const p = await mkProject('客户S35C系统', ctx.members.lead.id)

    // web PATCH 直改（引擎补全：此前任何通道都改不了牵头人）
    const adminCookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const patched = await authed(ctx.app, adminCookie, 'PATCH', `/api/v1/projects/${p.id}`, { leadMemberId: ctx.members.dev.id })
    expect(patched.status).toBe(200)
    expect(ctx.db.prepare('SELECT lead_member_id FROM projects WHERE id = ?').get(p.id).lead_member_id).toBe(ctx.members.dev.id)
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM project_events WHERE project_id = ? AND event_type = 'owner_change'").get(p.id).n).toBe(1)

    // 提议通道换牵头人 + 不在职成员起草即拒
    const keyId = ctx.members.key.id
    ctx.db.prepare("UPDATE members SET status = 'offboarded' WHERE id = ?").run(keyId)
    const off = await write(ctx.members.lead, 'propose', { kind: 'update_project', projectId: p.id, leadMemberId: keyId })
    expect(off.type).toBe('refused')
    const out = await write(ctx.members.admin, 'propose', { kind: 'update_project', projectId: p.id, leadMemberId: ctx.members.lead.id })
    expect(out.type).toBe('card')
    const ok = await authed(ctx.app, adminCookie, 'POST', `/api/v1/proposals/${out.proposalId}/confirm`, {})
    expect(ok.status).toBe(200)
    expect(ctx.db.prepare('SELECT lead_member_id FROM projects WHERE id = ?').get(p.id).lead_member_id).toBe(ctx.members.lead.id)
  })

  it('S35-4: 里程碑建议——改期/状态待确认事件，确认生效、met 落实际日期；假 id 拒绝；推送不误通知同 id 任务责任人', async () => {
    const p = await mkProject('客户S35D系统', ctx.members.lead.id)
    const adminCookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    // 里程碑 id 将与既有任务 id 重叠（都从小整数起算）——把任务 #1 责任人改成李四，
    // 旧 pushSuggestion 会误通知李四；修复后只推项目牵头人
    ctx.db.prepare('UPDATE tasks SET responsible_member_id = ? WHERE id = (SELECT MIN(id) FROM tasks WHERE project_id = ?)').run(ctx.members.dev.id, p.id)
    const ms = createMilestone(ctx.db, { projectId: p.id, name: '正式发布', planDate: '2026-12-01' }, ctx.members.lead.id)

    // 假 id / 非法字段拒绝
    const ghost = await write(ctx.members.lead, 'suggest_event', { targetMilestoneId: 99999, targetField: 'plan_date', targetValue: '2026-12-10' })
    expect(ghost.type).toBe('refused')
    const badField = await write(ctx.members.lead, 'suggest_event', { targetMilestoneId: ms.id, targetField: 'title', targetValue: 'X' })
    expect(badField.type).toBe('refused')

    // 改期建议 → pending 事件（target_object='milestone'）→ 确认生效
    const resched = await write(ctx.members.lead, 'suggest_event', { targetMilestoneId: ms.id, targetField: 'plan_date', targetValue: '2026-12-10' })
    expect(resched.type).toBe('card')
    expect(resched.cardKind).toBe('suggest')
    const e1 = ctx.db.prepare('SELECT * FROM project_events WHERE id = ?').get(resched.eventId)
    expect(e1.nature).toBe('suggestion')
    expect(e1.status).toBe('pending')
    expect(e1.target_object).toBe('milestone')
    expect(e1.target_task_id).toBe(ms.id)
    expect(e1.target_field).toBe('plan_date')
    expect(e1.event_type).toBe('schedule_change')
    // 推送只到项目牵头人（不误通知同 id 任务的李四）
    expect(JSON.parse(e1.pushed_to)).toEqual([ctx.members.lead.id])
    confirmEvent(ctx.db, resched.eventId, ctx.members.dev.id)
    expect(ctx.db.prepare('SELECT plan_date FROM milestones WHERE id = ?').get(ms.id).plan_date).toBe('2026-12-10')

    // 状态建议：met 落实际日期=今天（北京日）
    const met = await write(ctx.members.lead, 'suggest_event', { targetMilestoneId: ms.id, targetField: 'status', targetValue: 'met' })
    const e2 = ctx.db.prepare('SELECT * FROM project_events WHERE id = ?').get(met.eventId)
    expect(e2.event_type).toBe('status_change')
    confirmEvent(ctx.db, met.eventId, ctx.members.dev.id)
    const after = ctx.db.prepare('SELECT status, actual_date FROM milestones WHERE id = ?').get(ms.id)
    expect(after.status).toBe('met')
    expect(after.actual_date).toBe(today())
  })

  it('S35-5: add_milestone 提议——名称空白/项目不真实拒绝；确认后落 milestones(planned)', async () => {
    const p = await mkProject('客户S35E系统', ctx.members.lead.id)
    const noName = await write(ctx.members.lead, 'propose', { kind: 'add_milestone', projectId: p.id, name: '' })
    expect(noName.type).toBe('refused')
    const badProj = await write(ctx.members.lead, 'propose', { kind: 'add_milestone', projectId: 99999, name: 'X' })
    expect(badProj.type).toBe('refused')

    const out = await write(ctx.members.lead, 'propose', { kind: 'add_milestone', projectId: p.id, name: '客户验收', planDate: '2026-12-20' })
    expect(out.type).toBe('card')
    const leadCookie = await loginCookie(ctx.app, 'zhangsan', 'pass-123456')
    const ok = await authed(ctx.app, leadCookie, 'POST', `/api/v1/proposals/${out.proposalId}/confirm`, {})
    expect(ok.status).toBe(200)
    const ms = ctx.db.prepare('SELECT * FROM milestones WHERE project_id = ? AND name = ?').get(p.id, '客户验收')
    expect(ms.status).toBe('planned')
    expect(ms.plan_date).toBe('2026-12-20')
  })

  it('S35-6: 协议提示词含新动作与「不得谎称已生效」；私聊全链路口述→卡→点按→落库回执', async () => {
    const p = await mkProject('客户S35F系统', ctx.members.lead.id)
    const sys = buildSystemPrompt(ctx.db, {
      member: ctx.members.lead, channel: { channel_type: 'dedicated', project_id: p.id }, chatType: 'group', surface: 'im',
    })
    expect(sys).toContain('add_task')
    expect(sys).toContain('add_milestone')
    expect(sys).toContain('update_project')
    expect(sys).toContain('targetMilestoneId')
    expect(sys).toContain('不得谎称已生效')

    // 全链路：私聊口述建任务 → 提议卡 → 发令人点按生效 → 任务落库 + 回执
    const { llm } = scriptedLlm(
      JSON.stringify({ action: 'write', kind: 'propose', payload: { kind: 'add_task', projectId: p.id, title: '口述建的任务' } })
    )
    const rec = recorder()
    const out = await handleBotEvent(ctx.db, p2p('fs_zhang', `帮 ${p.name} 建个任务：口述建的任务`), { llm, send: rec.send, secret: SECRET })
    expect(out.result).toBe('card_sent')
    const card = rec.sent[0].card
    const confirmBtn = card.elements.find((e) => e.tag === 'action').actions[0]
    expect(confirmBtn.value.a).toBe('prop')
    const okRec = recorder()
    const done = await handleCardAction(ctx.db, { operatorOpenId: 'fs_zhang', value: confirmBtn.value, chatId: 'oc_p2p', messageId: nextMsgId() }, { send: okRec.send, secret: SECRET })
    expect(done.result).toBe('confirmed')
    expect(okRec.sent[0].text).toContain('已生效')
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND title = '口述建的任务'").get(p.id).n).toBe(1)
  })
})
