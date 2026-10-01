import { describe, it, expect, afterAll } from 'vitest'
import { setupApp, loginCookie, authed } from './helpers.mjs'
import { handleBotEvent, handleCardAction } from '../brain/bot/command.js'
import { hmac } from '../engine/auth.js'

// PRD S25（v0.17）— Agent 提议式项目与配置操作：通用提议→确认→生效（proposals）
// 项目状态/结项/新建项目/项目类型/任务模板；发起放开、确认按矩阵收紧；LLM 只起草不生效

let ctx
afterAll(() => { ctx?.db.close(); globalThis.fetch = undefined })

const SECRET = 's25-test-bot-hmac-secret-32-bytes!'

function fakeLlm(turns) {
  const q = [...turns]
  return { name: 'fake', async complete() { return JSON.stringify(q.shift() ?? { action: 'reply', text: '（兜底）' }) } }
}

async function mkProject(cookie, leadId, name, extra = {}) {
  const res = await authed(ctx.app, cookie, 'POST', '/api/v1/projects', {
    name, templateCode: 'software_delivery', leadMemberId: leadId, ...extra,
  })
  return res.body
}

async function chatPropose(cookie, sessionId, text, payloadTurn) {
  ctx.app.llm = fakeLlm([{ action: 'write', kind: 'propose', payload: payloadTurn }])
  return authed(ctx.app, cookie, 'POST', `/api/v1/chat/sessions/${sessionId}/messages`, { text })
}

describe('S25 Agent 提议式项目与配置操作', () => {
  it('S25-1: 提议暂停项目——确认前不变；无权人 403；牵头人确认后变更并留事件', async () => {
    ctx = await setupApp()
    const admin = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const lead = await loginCookie(ctx.app, 'zhangsan', 'pass-123456')
    const member = await loginCookie(ctx.app, 'lisi', 'pass-123456')
    const p = await mkProject(admin, ctx.members.lead.id, '客户P系统', { planEndDate: '2026-12-31' })
    const sid = (await authed(ctx.app, lead, 'POST', '/api/v1/chat/sessions', {})).body.id

    const res = await chatPropose(lead, sid, '把客户P系统暂停', { kind: 'update_project_status', projectId: p.id, status: 'paused' })
    expect(res.status).toBe(200)
    expect(res.body.assistant.content).toMatch(/提议.*#\d+|待确认/)
    const proposalId = res.body.assistant.meta.proposalId
    expect(proposalId).toBeTruthy()
    // 确认前项目不变
    expect(ctx.db.prepare('SELECT status FROM projects WHERE id = ?').get(p.id).status).toBe('planning')
    // 无权成员（非牵头人非管理员）确认 403
    expect((await authed(ctx.app, member, 'POST', `/api/v1/proposals/${proposalId}/confirm`)).status).toBe(403)
    // 牵头人确认生效 + 留 status_change 事件
    expect((await authed(ctx.app, lead, 'POST', `/api/v1/proposals/${proposalId}/confirm`)).status).toBe(200)
    expect(ctx.db.prepare('SELECT status FROM projects WHERE id = ?').get(p.id).status).toBe('paused')
    const evt = ctx.db.prepare(`SELECT * FROM project_events WHERE project_id = ? AND event_type = 'status_change'`).get(p.id)
    expect(evt).toBeTruthy()
    const row = ctx.db.prepare('SELECT * FROM proposals WHERE id = ?').get(proposalId)
    expect(row.status).toBe('effective')
    expect(row.decided_by).toBe(ctx.members.lead.id)
  })

  it('S25-2: 提议启动——无交付日期时载荷须同补（S21）；缺日期 refused', async () => {
    ctx = await setupApp()
    const admin = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const lead = await loginCookie(ctx.app, 'zhangsan', 'pass-123456')
    const p = await mkProject(admin, ctx.members.lead.id, '无期项目') // 无交付日期
    const sid = (await authed(ctx.app, lead, 'POST', '/api/v1/chat/sessions', {})).body.id

    const bad = await chatPropose(lead, sid, '把它启动', { kind: 'update_project_status', projectId: p.id, status: 'active' })
    expect(bad.body.assistant.content).toMatch(/交付日期/)

    const ok = await chatPropose(lead, sid, '12 月 31 日交付，启动吧', {
      kind: 'update_project_status', projectId: p.id, status: 'active', planEndDate: '2026-12-31',
    })
    const proposalId = ok.body.assistant.meta.proposalId
    expect(proposalId).toBeTruthy()
    expect((await authed(ctx.app, lead, 'POST', `/api/v1/proposals/${proposalId}/confirm`)).status).toBe(200)
    const row = ctx.db.prepare('SELECT status, actual_start_date, plan_end_date FROM projects WHERE id = ?').get(p.id)
    expect(row.status).toBe('active')
    expect(row.plan_end_date).toBe('2026-12-31')
    expect(row.actual_start_date).toBeTruthy()
  })

  it('S25-3: 提议结项——确认时按 S8 强校验（未完成 409 且提议保持 pending）；全完成后可结项', async () => {
    ctx = await setupApp()
    const admin = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const p = await mkProject(admin, ctx.members.lead.id, '待结项目', { planEndDate: '2026-12-31' })
    const sid = (await authed(ctx.app, admin, 'POST', '/api/v1/chat/sessions', {})).body.id

    const res = await chatPropose(admin, sid, '把待结项目结项', { kind: 'close_project', projectId: p.id })
    const proposalId = res.body.assistant.meta.proposalId
    expect(proposalId).toBeTruthy()

    const blocked = await authed(ctx.app, admin, 'POST', `/api/v1/proposals/${proposalId}/confirm`)
    expect(blocked.status).toBe(409)
    expect(blocked.body.message).toMatch(/未完成/)
    expect(ctx.db.prepare('SELECT status FROM proposals WHERE id = ?').get(proposalId).status).toBe('pending')

    ctx.db.prepare(`UPDATE tasks SET status = 'done' WHERE project_id = ?`).run(p.id)
    expect((await authed(ctx.app, admin, 'POST', `/api/v1/proposals/${proposalId}/confirm`)).status).toBe(200)
    expect(ctx.db.prepare('SELECT status FROM projects WHERE id = ?').get(p.id).status).toBe('closed')
  })

  it('S25-4: 提议新建项目——类型实例化/自定义任务+倒排同构；拟任牵头人/管理员确认；无权人 403；缺载荷 refused', async () => {
    ctx = await setupApp()
    const admin = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const member = await loginCookie(ctx.app, 'lisi', 'pass-123456')
    const sid = (await authed(ctx.app, member, 'POST', '/api/v1/chat/sessions', {})).body.id

    const bad = await chatPropose(member, sid, '建个项目', { kind: 'create_project', leadMemberId: ctx.members.lead.id })
    expect(bad.body.assistant.content).toMatch(/必填/)

    // 自定义任务清单 + 倒排（v0.18）：AI 起草 tasks，日期算术由 engine 确定性完成
    const ok = await chatPropose(member, sid, '立项：客户Q系统，软件交付', {
      kind: 'create_project', name: '客户Q系统', typeCode: 'software_delivery',
      leadMemberId: ctx.members.lead.id, planStartDate: '2026-10-01', planEndDate: '2026-12-31',
      tasks: ['需求冻结', '方案评审', '开发联调', '验收上线'], autoSchedule: true,
    })
    const proposalId = ok.body.assistant.meta.proposalId
    expect(proposalId).toBeTruthy()
    // 提议人（普通成员，非管理员非拟任牵头人）确认 403
    expect((await authed(ctx.app, member, 'POST', `/api/v1/proposals/${proposalId}/confirm`)).status).toBe(403)
    // 拟任牵头人确认 → 项目 + 自定义任务实例化（source=manual）+ 倒排填计划起止
    const lead = await loginCookie(ctx.app, 'zhangsan', 'pass-123456')
    expect((await authed(ctx.app, lead, 'POST', `/api/v1/proposals/${proposalId}/confirm`)).status).toBe(200)
    const created = ctx.db.prepare(`SELECT * FROM projects WHERE name = '客户Q系统'`).get()
    expect(created).toBeTruthy()
    expect(created.lead_member_id).toBe(ctx.members.lead.id)
    const tasks = ctx.db.prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY id').all(created.id)
    expect(tasks.map((t) => t.title)).toEqual(['需求冻结', '方案评审', '开发联调', '验收上线'])
    expect(tasks.every((t) => t.source === 'manual')).toBe(true)
    // 倒排：末条截止=交付日期，全部任务有计划起止（S1-7 公式）
    expect(tasks.every((t) => t.plan_start_date && t.plan_end_date)).toBe(true)
    expect(tasks.at(-1).plan_end_date).toBe('2026-12-31')

    // 类型实例化路径（无 tasks）仍走类型内嵌清单
    const plain = await chatPropose(member, sid, '立项：客户T系统', {
      kind: 'create_project', name: '客户T系统', typeCode: 'software_delivery', leadMemberId: ctx.members.lead.id,
    })
    const plainId = plain.body.assistant.meta.proposalId
    expect((await authed(ctx.app, admin, 'POST', `/api/v1/proposals/${plainId}/confirm`)).status).toBe(200)
    const n = ctx.db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE project_id = (SELECT id FROM projects WHERE name = '客户T系统')`).get().n
    expect(n).toBeGreaterThan(0)
  })

  it('S25-5: 类型提议——仅管理员确认生效（内嵌任务清单校验同构）；非管理员 403；模板类 kind refused', async () => {
    ctx = await setupApp()
    const admin = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const member = await loginCookie(ctx.app, 'lisi', 'pass-123456')
    const sid = (await authed(ctx.app, member, 'POST', '/api/v1/chat/sessions', {})).body.id

    // 新建项目类型：字符串任务清单（LLM 友好）内嵌，成员提议 → 管理员确认
    const type = await chatPropose(member, sid, '建个类型', {
      kind: 'create_project_type', code: 'type_s25', name: 'S25 类型',
      tasks: ['需求确认', '方案设计', '上线交付'],
    })
    const typeId = type.body.assistant.meta.proposalId
    expect((await authed(ctx.app, member, 'POST', `/api/v1/proposals/${typeId}/confirm`)).status).toBe(403)
    expect((await authed(ctx.app, admin, 'POST', `/api/v1/proposals/${typeId}/confirm`)).status).toBe(200)
    const typeRow = ctx.db.prepare(`SELECT * FROM project_types WHERE code = 'type_s25'`).get()
    expect(typeRow).toBeTruthy()
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM project_type_tasks WHERE type_id = ?').get(typeRow.id).n).toBe(3)

    // 模板类 kind 已裁撤（v0.18）→ refused
    const gone = await chatPropose(member, sid, '建个模板', {
      kind: 'create_task_template', code: 'tpl_s25', name: '旧模板', tasks: ['需求确认'],
    })
    expect(gone.body.assistant.content).toMatch(/create_task_template|提议类型/)
    const gone2 = await chatPropose(member, sid, '改模板', {
      kind: 'update_task_template', templateCode: 'tpl_s25', tasks: ['新任务A'],
    })
    expect(gone2.body.assistant.content).toMatch(/update_task_template|提议类型/)
  })

  it('S25-6: 飞书确认卡——HMAC 签名 + 点按人实时权限；与 web 同一 confirmProposal 口子', async () => {
    ctx = await setupApp()
    const admin = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const p = await mkProject(admin, ctx.members.lead.id, '客户R系统', { planEndDate: '2026-12-31' })

    let msgId = 0
    const sent = []
    const send = async ({ card }) => { if (card) sent.push(card); return { messageId: `om_${++msgId}` } }
    const llm = fakeLlm([{ action: 'write', kind: 'propose', payload: { kind: 'update_project_status', projectId: p.id, status: 'paused' } }])
    const out = await handleBotEvent(ctx.db, {
      messageId: 's25-card-1', chatId: 'oc_p2p', chatType: 'p2p', senderOpenId: 'fs_zhang', text: '把客户R系统暂停',
    }, { llm, send, secret: SECRET })
    expect(out.result).toBe('card_sent')
    expect(sent.length).toBe(1)
    const actions = (c) => c.elements.flatMap((e) => e.actions || [])
    const confirmBtn = actions(sent[0]).find((b) => /确认/.test(b.text.content))

    // 伪造签名拒
    const forged = await handleCardAction(ctx.db, {
      operatorOpenId: 'fs_zhang', chatId: 'oc_p2p', messageId: `cm_${++msgId}`,
      value: { ...confirmBtn.value, s: 'deadbeef' },
    }, { send, secret: SECRET })
    expect(forged.result).not.toBe('confirmed')

    // 无权点按（李四非牵头人非管理员）
    const denied = await handleCardAction(ctx.db, {
      operatorOpenId: 'fs_li', chatId: 'oc_p2p', messageId: `cm_${++msgId}`, value: confirmBtn.value,
    }, { send, secret: SECRET })
    expect(denied.result).toBe('refused_permission')

    // 牵头人点确认 → 生效
    const ok = await handleCardAction(ctx.db, {
      operatorOpenId: 'fs_zhang', chatId: 'oc_p2p', messageId: `cm_${++msgId}`, value: confirmBtn.value,
    }, { send, secret: SECRET })
    expect(ok.result).toBe('confirmed')
    expect(ctx.db.prepare('SELECT status FROM projects WHERE id = ?').get(p.id).status).toBe('paused')

    // 驳回路径：再建一条提议后驳回
    const llm2 = fakeLlm([{ action: 'write', kind: 'propose', payload: { kind: 'update_project_status', projectId: p.id, status: 'active', planEndDate: '2026-12-31' } }])
    await handleBotEvent(ctx.db, {
      messageId: 's25-card-2', chatId: 'oc_p2p', chatType: 'p2p', senderOpenId: 'fs_zhang', text: '再启动',
    }, { llm: llm2, send, secret: SECRET })
    const rejectBtn = actions(sent[1]).find((b) => /驳回/.test(b.text.content))
    const rej = await handleCardAction(ctx.db, {
      operatorOpenId: 'fs_zhang', chatId: 'oc_p2p', messageId: `cm_${++msgId}`, value: rejectBtn.value,
    }, { send, secret: SECRET })
    expect(rej.result).toBe('rejected')
    expect(ctx.db.prepare('SELECT status FROM projects WHERE id = ?').get(p.id).status).toBe('paused')
    void hmac
  })
})
