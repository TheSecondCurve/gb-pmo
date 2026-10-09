import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupApp, loginCookie, authed } from './helpers.mjs'
import { handleBotEvent, handleCardAction, buildSystemPrompt } from '../brain/bot/command.js'
import { runWriteTool } from '../brain/bot/tools.js'
import { createMilestone } from '../engine/tasks.js'
import { today } from '../db/time.js'

// PRD S35（v0.39；v0.46/K25 直改化）— 机器人项目维护面补全：建任务/建里程碑/项目信息变更/里程碑改期与状态
// 全部直接生效并回执——软校验 + 发起人权限前置（复用原确认矩阵）后直写既有引擎（终态守卫/审计/留痕全继承）；
// 确认卡仅余取消/结项提议（S25）。
// v0.42/S38 修订：add_task 缺省责任人=未指派（D3 已由 K20 推翻）。

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

beforeAll(async () => {
  ctx = await setupApp()
})
afterAll(() => ctx?.db.close())

describe('S35 机器人项目维护面补全（v0.46 直改）', () => {
  it('S35-1: add_task 直改——软校验拒绝不落库；牵头人发起直接生效（缺省未指派（v0.42/S38）+ 审计）；无权发起人拒绝；终态项目拒绝只读', async () => {
    const p = await mkProject('客户S35系统', ctx.members.lead.id)

    // 软校验：title 空白 / projectId 不真实 → refused，不落任何业务行
    const badTitle = await write(ctx.members.lead, 'propose', { kind: 'add_task', projectId: p.id, title: '  ' })
    expect(badTitle.type).toBe('refused')
    expect(badTitle.text).toContain('title')
    const badProj = await write(ctx.members.lead, 'propose', { kind: 'add_task', projectId: 99999, title: 'X' })
    expect(badProj.type).toBe('refused')
    const tasksOf = () => ctx.db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND title = ?').get(p.id, '365 连麦表单城市字段修复').n
    expect(tasksOf()).toBe(0)

    // 权限前置（原确认矩阵）：非牵头人且非管理员发起 → refused_permission，不落库
    const denied = await write(ctx.members.dev, 'propose', { kind: 'add_task', projectId: p.id, title: '李四越权的任务' })
    expect(denied.type).toBe('refused')
    expect(denied.result).toBe('refused_permission')
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE title = '李四越权的任务'").get().n).toBe(0)

    // 牵头人发起 → 直接生效：todo / 责任人缺省=未指派 / 审计 task.create / 回执已生效（不再落 proposals）
    const proposalsBefore = ctx.db.prepare('SELECT COUNT(*) AS n FROM proposals').get().n
    const out = await write(ctx.members.lead, 'propose', { kind: 'add_task', projectId: p.id, title: '365 连麦表单城市字段修复', planEndDate: '2026-10-20' })
    expect(out.type).toBe('receipt')
    expect(out.text).toContain('已生效')
    expect(out.text).toContain('未指派')
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM proposals').get().n).toBe(proposalsBefore)
    const task = ctx.db.prepare('SELECT * FROM tasks WHERE project_id = ? AND title = ?').get(p.id, '365 连麦表单城市字段修复')
    expect(task.status).toBe('todo')
    expect(task.responsible_member_id).toBeNull()
    expect(task.plan_end_date).toBe('2026-10-20')
    const audited = ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'task.create' AND object_id = ?").get(String(task.id)).n
    expect(audited).toBe(1)

    // 终态项目：直接拒绝提示只读（先按 S8 清空未完任务才能结项）
    ctx.db.prepare("UPDATE tasks SET status = 'done', actual_end_date = ? WHERE project_id = ?").run(today(), p.id)
    const leadCookie = await loginCookie(ctx.app, 'zhangsan', 'pass-123456')
    const closed = await authed(ctx.app, leadCookie, 'POST', `/api/v1/projects/${p.id}/close`, { summary: 'S35 结项用例' })
    expect(closed.status).toBe(200)
    const late = await write(ctx.members.lead, 'propose', { kind: 'add_task', projectId: p.id, title: '结项后的任务' })
    expect(late.type).toBe('refused')
    expect(late.text).toContain('只读')
  })

  it('S35-2: update_project 直改——无字段/非法优先级/改 status 拒绝；牵头人发起直接生效走 updateProject 同一校验留痕', async () => {
    const p = await mkProject('客户S35B系统', ctx.members.lead.id)

    // 拒绝三连：无变更字段 / 非法优先级 / 试图改 status（S29）
    const noFields = await write(ctx.members.lead, 'propose', { kind: 'update_project', projectId: p.id })
    expect(noFields.type).toBe('refused')
    const badPriority = await write(ctx.members.lead, 'propose', { kind: 'update_project', projectId: p.id, priority: 'urgent' })
    expect(badPriority.type).toBe('refused')
    const withStatus = await write(ctx.members.lead, 'propose', { kind: 'update_project', projectId: p.id, status: 'closed' })
    expect(withStatus.type).toBe('refused')
    expect(withStatus.text).toContain('结项')

    // 非牵头人非管理员发起 → 权限拒绝
    const denied = await write(ctx.members.dev, 'propose', { kind: 'update_project', projectId: p.id, priority: 'high' })
    expect(denied.type).toBe('refused')
    expect(denied.result).toBe('refused_permission')

    // 牵头人发起直改：优先级与客户名立即生效、优先级变更落事件、审计可查
    const out = await write(ctx.members.lead, 'propose', { kind: 'update_project', projectId: p.id, priority: 'high', clientName: '新客户名' })
    expect(out.type).toBe('receipt')
    expect(out.text).toContain('已生效')
    const after = ctx.db.prepare('SELECT priority, client_name FROM projects WHERE id = ?').get(p.id)
    expect(after.priority).toBe('high')
    expect(after.client_name).toBe('新客户名')
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM project_events WHERE project_id = ? AND event_type = 'priority_change'").get(p.id).n).toBeGreaterThanOrEqual(1)
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'project.update' AND object_id = ?").get(String(p.id)).n).toBeGreaterThanOrEqual(1)
  })

  it('S35-3: update_project 换牵头人——web PATCH 同通道生效并落 owner_change；不在职牵头人发起即拒；直改生效', async () => {
    const p = await mkProject('客户S35C系统', ctx.members.lead.id)
    const adminCookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')

    // web PATCH 直改（引擎补全：此前任何通道都改不了牵头人）
    const patched = await authed(ctx.app, adminCookie, 'PATCH', `/api/v1/projects/${p.id}`, { leadMemberId: ctx.members.dev.id })
    expect(patched.status).toBe(200)
    expect(ctx.db.prepare('SELECT lead_member_id FROM projects WHERE id = ?').get(p.id).lead_member_id).toBe(ctx.members.dev.id)
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM project_events WHERE project_id = ? AND event_type = 'owner_change'").get(p.id).n).toBe(1)

    // 对话面换牵头人：不在职成员发起即拒；管理员发起直改生效
    const keyId = ctx.members.key.id
    ctx.db.prepare("UPDATE members SET status = 'offboarded' WHERE id = ?").run(keyId)
    const off = await write(ctx.members.lead, 'propose', { kind: 'update_project', projectId: p.id, leadMemberId: keyId })
    expect(off.type).toBe('refused')
    const out = await write(ctx.members.admin, 'propose', { kind: 'update_project', projectId: p.id, leadMemberId: ctx.members.lead.id })
    expect(out.type).toBe('receipt')
    expect(ctx.db.prepare('SELECT lead_member_id FROM projects WHERE id = ?').get(p.id).lead_member_id).toBe(ctx.members.lead.id)
  })

  it('S35-4: 里程碑建议直改——落建议型事件立即以发令人身份生效；met 落实际日期；假 id 拒绝', async () => {
    const p = await mkProject('客户S35D系统', ctx.members.lead.id)
    const ms = createMilestone(ctx.db, { projectId: p.id, name: '正式发布', planDate: '2026-12-01' }, ctx.members.lead.id)

    // 假 id / 非法字段拒绝
    const ghost = await write(ctx.members.lead, 'suggest_event', { targetMilestoneId: 99999, targetField: 'plan_date', targetValue: '2026-12-10' })
    expect(ghost.type).toBe('refused')
    const badField = await write(ctx.members.lead, 'suggest_event', { targetMilestoneId: ms.id, targetField: 'title', targetValue: 'X' })
    expect(badField.type).toBe('refused')

    // 改期 → 直改生效：事件 effective、decided_by=发令人、不再推送
    const resched = await write(ctx.members.lead, 'suggest_event', { targetMilestoneId: ms.id, targetField: 'plan_date', targetValue: '2026-12-10' })
    expect(resched.type).toBe('receipt')
    expect(resched.text).toContain('已生效')
    expect(resched.text).toContain('2026-12-10')
    const e1 = ctx.db.prepare(`SELECT * FROM project_events WHERE project_id = ? AND target_object = 'milestone' ORDER BY id DESC`).get(p.id)
    expect(e1.nature).toBe('suggestion')
    expect(e1.status).toBe('effective')
    expect(e1.decided_by).toBe(ctx.members.lead.id)
    expect(e1.target_task_id).toBe(ms.id)
    expect(e1.target_field).toBe('plan_date')
    expect(e1.event_type).toBe('schedule_change')
    expect(JSON.parse(e1.pushed_to)).toEqual([])
    expect(ctx.db.prepare('SELECT plan_date FROM milestones WHERE id = ?').get(ms.id).plan_date).toBe('2026-12-10')

    // 状态建议：met 落实际日期=今天（北京日）
    const met = await write(ctx.members.lead, 'suggest_event', { targetMilestoneId: ms.id, targetField: 'status', targetValue: 'met' })
    expect(met.type).toBe('receipt')
    const after = ctx.db.prepare('SELECT status, actual_date FROM milestones WHERE id = ?').get(ms.id)
    expect(after.status).toBe('met')
    expect(after.actual_date).toBe(today())
  })

  it('S35-5: add_milestone 直改——名称空白/项目不真实拒绝；牵头人发起直接落 milestones(planned)', async () => {
    const p = await mkProject('客户S35E系统', ctx.members.lead.id)
    const noName = await write(ctx.members.lead, 'propose', { kind: 'add_milestone', projectId: p.id, name: '' })
    expect(noName.type).toBe('refused')
    const badProj = await write(ctx.members.lead, 'propose', { kind: 'add_milestone', projectId: 99999, name: 'X' })
    expect(badProj.type).toBe('refused')
    const denied = await write(ctx.members.dev, 'propose', { kind: 'add_milestone', projectId: p.id, name: '越权里程碑' })
    expect(denied.type).toBe('refused')
    expect(denied.result).toBe('refused_permission')

    const out = await write(ctx.members.lead, 'propose', { kind: 'add_milestone', projectId: p.id, name: '客户验收', planDate: '2026-12-20' })
    expect(out.type).toBe('receipt')
    expect(out.text).toContain('已生效')
    const ms = ctx.db.prepare('SELECT * FROM milestones WHERE project_id = ? AND name = ?').get(p.id, '客户验收')
    expect(ms.status).toBe('planned')
    expect(ms.plan_date).toBe('2026-12-20')
  })

  it('S35-6: 协议提示词含新动作与「不得谎称已生效」；私聊全链路口述→直改→落库回执；取消项目仍出确认卡', async () => {
    const p = await mkProject('客户S35F系统', ctx.members.lead.id)
    const sys = buildSystemPrompt(ctx.db, {
      member: ctx.members.lead, channel: { channel_type: 'dedicated', project_id: p.id }, chatType: 'group', surface: 'im',
    })
    expect(sys).toContain('add_task')
    expect(sys).toContain('add_milestone')
    expect(sys).toContain('update_project')
    expect(sys).toContain('targetMilestoneId')
    expect(sys).toContain('不得谎称已生效')

    // 全链路：私聊口述建任务 → 直改落库 → 回执已生效（无卡）
    const { llm } = scriptedLlm(
      JSON.stringify({ action: 'write', kind: 'propose', payload: { kind: 'add_task', projectId: p.id, title: '口述建的任务' } })
    )
    const rec = recorder()
    const out = await handleBotEvent(ctx.db, p2p('fs_zhang', `帮 ${p.name} 建个任务：口述建的任务`), { llm, send: rec.send, secret: SECRET })
    expect(out.result).toBe('replied')
    expect(rec.sent[0].text).toContain('已生效')
    expect(rec.sent[0].card).toBeUndefined()
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND title = '口述建的任务'").get(p.id).n).toBe(1)

    // 终态操作仍走确认卡：取消项目提议 → card_sent → 牵头人点按生效
    const cancelLlm = scriptedLlm(
      JSON.stringify({ action: 'write', kind: 'propose', payload: { kind: 'cancel_project', projectId: p.id, reason: '客户不做了' } })
    )
    const cardRec = recorder()
    const cardOut = await handleBotEvent(ctx.db, p2p('fs_zhang', '取消这个项目'), { llm: cancelLlm.llm, send: cardRec.send, secret: SECRET })
    expect(cardOut.result).toBe('card_sent')
    const confirmBtn = cardRec.sent[0].card.elements.find((e) => e.tag === 'action').actions[0]
    expect(confirmBtn.value.a).toBe('prop')
    const okRec = recorder()
    const done = await handleCardAction(ctx.db, { operatorOpenId: 'fs_zhang', value: confirmBtn.value, chatId: 'oc_p2p', messageId: nextMsgId() }, { send: okRec.send, secret: SECRET })
    expect(done.result).toBe('confirmed')
    expect(okRec.sent[0].text).toContain('已生效')
    expect(ctx.db.prepare('SELECT status FROM projects WHERE id = ?').get(p.id).status).toBe('cancelled')
  })
})

describe('S35 软校验拒绝分支（工具层：不真实 id / 非法值一律 refused 中文理由，不落库）', () => {
  it('里程碑建议：假 id / 终态项目 / 项目不符 / 非法字段 / 非法日期 / 非法状态值', async () => {
    const lead = { id: ctx.members.lead.id, name: '张三', role: 'member' }
    const p = await mkProject('校验项目', ctx.members.lead.id)
    const ms = createMilestone(ctx.db, { projectId: p.id, name: '验收', planDate: '2026-11-01' }, 1)
    const other = await mkProject('另一个项目', ctx.members.lead.id)

    const refuse = async (payload, word) => {
      const r = await write(lead, 'suggest_event', payload)
      expect(r.type).toBe('refused')
      expect(r.text).toContain(word)
    }
    await refuse({ targetMilestoneId: 999999, targetField: 'plan_date', targetValue: '2026-11-05' }, '真实里程碑')
    await refuse({ targetMilestoneId: ms.id, projectId: other.id, targetField: 'plan_date', targetValue: '2026-11-05' }, '里程碑不属于')
    await refuse({ targetMilestoneId: ms.id, targetField: 'name', targetValue: '改名' }, '仅支持 plan_date / status')
    await refuse({ targetMilestoneId: ms.id, targetField: 'plan_date', targetValue: '下周' }, 'YYYY-MM-DD')
    await refuse({ targetMilestoneId: ms.id, targetField: 'status', targetValue: 'done' }, 'planned / met / missed / cancelled')

    // 终态项目：任务清空后结项，里程碑建议拒绝（任务面只读）
    ctx.db.prepare(`DELETE FROM tasks WHERE project_id = ?`).run(p.id)
    const { closeProject } = await import('../engine/projects.js')
    closeProject(ctx.db, p.id, { summary: '提前收尾' }, 1)
    await refuse({ targetMilestoneId: ms.id, targetField: 'plan_date', targetValue: '2026-11-05' }, '只读')
  })

  it('提议：create_project 类型码不存在 / add_task 责任人不存在 / 任务 refs 链接非 http(s) 提前拦截', async () => {
    const lead = { id: ctx.members.lead.id, name: '张三', role: 'member' }
    const p = await mkProject('提议校验项目', ctx.members.lead.id)

    const t1 = await write(lead, 'propose', { kind: 'create_project', name: 'X', leadMemberId: ctx.members.lead.id, typeCode: 'nope' })
    expect(t1.type).toBe('refused')
    expect(t1.text).toContain('不存在或已停用')

    const t2 = await write(lead, 'propose', { kind: 'add_task', projectId: p.id, title: '带人任务', responsibleMemberId: 999999 })
    expect(t2.type).toBe('refused')
    expect(t2.text).toContain('不存在或已离职')

    // S33：载荷任务 refs 链接非 http(s) —— 提议提前校验（引擎确认时兜底再校验一次）
    const t3 = await write(lead, 'propose', { kind: 'create_project', name: 'Y', leadMemberId: ctx.members.lead.id, typeCode: 'lianmai_365', tasks: [{ title: 'T', refs: [{ title: 'R', url: 'ftp://x' }] }] })
    expect(t3.type).toBe('refused')
    expect(t3.text).toMatch(/http/)
  })
})
