import { describe, it, expect, afterAll } from 'vitest'
import { setupApp, loginCookie, authed } from './helpers.mjs'
import { queryMetric } from '../engine/metrics.js'
import { overdueTasksOf, tasksInventory } from '../engine/tasks.js'
import { today, addDays } from '../db/time.js'

// PRD S36 — 任务删除（软删，v0.40）：web 任务面 DELETE /api/v1/tasks/:id + Agent action delete_task 双通道；
// 行保留留痕（deleted_at）、task_refs 同事务级联软删、task_records/讨论面历史事件保留；
// 已删任务退出一切读侧口径（列表/详情/未指派/逾期/盘点/指标），结项校验放行，待确认建议不复活。

let ctx
afterAll(() => ctx?.db.close())

async function admin() {
  return loginCookie(ctx.app, 'admin', 'admin-pass-123')
}

async function mkProject(name) {
  const res = await authed(ctx.app, await admin(), 'POST', '/api/v1/projects', {
    name, templateCode: 'lianmai_365', leadMemberId: ctx.members.lead.id, planEndDate: addDays(today(), 30),
  })
  if (res.status !== 201) throw new Error(`mkProject failed: ${res.status} ${JSON.stringify(res.body)}`)
  return res.body
}

async function agent(method, url, payload, token) {
  const res = await ctx.app.inject({ method, url, payload, headers: { authorization: `Bearer ${token}` } })
  return { status: res.statusCode, body: res.json() }
}

describe('S36 任务删除（软删）', () => {
  it('S36-1: web 删除任务 → 列表与项目详情消失；行保留 deleted_at 落值 + task.delete 审计', async () => {
    ctx = await setupApp()
    const cookie = await admin()
    const p = await mkProject('软删项目')
    const taskId = p.tasks[0].id
    const title = p.tasks[0].title

    // 普通成员也可删（D1 全员透明，与任务创建/更新同口径，留痕走审计）
    const zc = await loginCookie(ctx.app, 'lisi', 'pass-123456')
    const del = await authed(ctx.app, zc, 'DELETE', `/api/v1/tasks/${taskId}`)
    expect(del.status).toBe(200)
    expect(del.body.ok).toBe(true)

    const list = await authed(ctx.app, cookie, 'GET', `/api/v1/tasks?projectId=${p.id}`)
    expect(list.body.tasks.find((t) => t.id === taskId)).toBeUndefined()
    const detail = await authed(ctx.app, cookie, 'GET', `/api/v1/projects/${p.id}`)
    expect(detail.body.tasks.find((t) => t.id === taskId)).toBeUndefined()

    // 软删留痕：行保留、deleted_at 落值、审计带项目与标题
    const row = ctx.db.prepare('SELECT title, deleted_at FROM tasks WHERE id = ?').get(taskId)
    expect(row.title).toBe(title)
    expect(row.deleted_at).toBeGreaterThan(0)
    const auditRow = ctx.db.prepare(`SELECT * FROM audit_logs WHERE action = 'task.delete' AND object_id = ?`).get(String(taskId))
    expect(auditRow).toBeTruthy()
  })

  it('S36-2: 删除带参考资料的任务 → refs 同事务软删；更新记录与讨论面历史事件保留', async () => {
    const cookie = await admin()
    const p = await mkProject('级联项目')
    const taskId = p.tasks[0].id
    const ref = await authed(ctx.app, cookie, 'POST', `/api/v1/tasks/${taskId}/refs`, { title: '部署 SOP', url: 'https://wiki.example.com/sop' })
    expect(ref.status).toBe(201)
    const rec = await authed(ctx.app, cookie, 'POST', `/api/v1/tasks/${taskId}/records`, { content: '进展记录一条' })
    expect(rec.status).toBe(201)
    const evt = await authed(ctx.app, cookie, 'POST', `/api/v1/projects/${p.id}/events`, {
      eventType: 'progress', nature: 'record', summary: '群聊进展快照', targetTaskId: taskId,
    })
    expect(evt.status).toBe(201)

    expect((await authed(ctx.app, cookie, 'DELETE', `/api/v1/tasks/${taskId}`)).status).toBe(200)

    // refs 级联软删（行保留）；records append-only 保留；讨论面事件保留（append-only，历史仍可见标题）
    const refRow = ctx.db.prepare('SELECT deleted_at FROM task_refs WHERE task_id = ?').get(taskId)
    expect(refRow.deleted_at).toBeGreaterThan(0)
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM task_records WHERE task_id = ?').get(taskId).n).toBe(1)
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM project_events WHERE target_task_id = ?').get(taskId).n).toBe(1)
    const refs = await authed(ctx.app, cookie, 'GET', `/api/v1/tasks/${taskId}/refs`)
    expect(refs.body.refs.length).toBe(0)
  })

  it('S36-3: 结项/取消项目删除 409「任务面只读」；任务不存在或已删除 404', async () => {
    const cookie = await admin()
    const p = await mkProject('终态项目')
    for (const t of p.tasks) {
      expect((await authed(ctx.app, cookie, 'PATCH', `/api/v1/tasks/${t.id}`, { status: 'done' })).status).toBe(200)
    }
    expect((await authed(ctx.app, cookie, 'POST', `/api/v1/projects/${p.id}/close`, { summary: '结项总结' })).status).toBe(200)
    const del = await authed(ctx.app, cookie, 'DELETE', `/api/v1/tasks/${p.tasks[0].id}`)
    expect(del.status).toBe(409)
    expect(del.body.message).toContain('只读')

    // 已取消项目同守卫（S2-3 终态只读）
    const p2 = await mkProject('取消项目')
    expect((await authed(ctx.app, cookie, 'POST', `/api/v1/projects/${p2.id}/cancel`, { reason: '客户叫停' })).status).toBe(200)
    expect((await authed(ctx.app, cookie, 'DELETE', `/api/v1/tasks/${p2.tasks[0].id}`)).status).toBe(409)

    // 不存在 404；重复删除同一任务 404（已删即不存在）
    expect((await authed(ctx.app, cookie, 'DELETE', '/api/v1/tasks/999999')).status).toBe(404)
    const p3 = await mkProject('重复删除项目')
    const tid = p3.tasks[0].id
    expect((await authed(ctx.app, cookie, 'DELETE', `/api/v1/tasks/${tid}`)).status).toBe(200)
    expect((await authed(ctx.app, cookie, 'DELETE', `/api/v1/tasks/${tid}`)).status).toBe(404)
  })

  it('S36-4: 删除仅剩的未完任务后结项放行（已删任务不计入未完）', async () => {
    const cookie = await admin()
    const p = await mkProject('结项放行项目')
    for (const t of p.tasks.slice(1)) {
      await authed(ctx.app, cookie, 'PATCH', `/api/v1/tasks/${t.id}`, { status: 'done' })
    }
    const blocked = await authed(ctx.app, cookie, 'POST', `/api/v1/projects/${p.id}/close`, { summary: '结项总结' })
    expect(blocked.status).toBe(409) // S8-1：有未完任务卡住结项

    expect((await authed(ctx.app, cookie, 'DELETE', `/api/v1/tasks/${p.tasks[0].id}`)).status).toBe(200)
    const close = await authed(ctx.app, cookie, 'POST', `/api/v1/projects/${p.id}/close`, { summary: '结项总结' })
    expect(close.status).toBe(200)
  })

  it('S36-5: 已删任务退出未指派视图、逾期计数、任务盘点与指标口径', async () => {
    const cookie = await admin()
    const p = await mkProject('口径退出项目')
    const [a, b] = p.tasks
    // A 未指派（责任人置空 + 已设计划开始，S2-1 口径）；B 逾期（截止昨天，责任人=牵头人）
    expect((await authed(ctx.app, cookie, 'PATCH', `/api/v1/tasks/${a.id}`, {
      responsibleMemberId: '', planStartDate: today(), planEndDate: addDays(today(), 5),
    })).status).toBe(200)
    expect((await authed(ctx.app, cookie, 'PATCH', `/api/v1/tasks/${b.id}`, { planEndDate: addDays(today(), -1) })).status).toBe(200)

    const unBefore = await authed(ctx.app, cookie, 'GET', '/api/v1/tasks/unassigned')
    expect(unBefore.body.tasks.some((t) => t.id === a.id)).toBe(true)
    expect(overdueTasksOf(ctx.db, ctx.members.lead.id).some((t) => t.id === b.id)).toBe(true)
    expect(tasksInventory(ctx.db, { projectId: p.id }).text).toContain(a.title)
    expect(queryMetric(ctx.db, 'overdue_tasks', { groupBy: 'project' }).rows.find((r) => r.project === p.name).overdue).toBe(1)
    expect(queryMetric(ctx.db, 'unassigned_tasks', { groupBy: 'project' }).rows.find((r) => r.project === p.name)?.count).toBe(1)
    const listBefore = await authed(ctx.app, cookie, 'GET', '/api/v1/projects')
    expect(listBefore.body.projects.find((x) => x.id === p.id).overdueTasks).toBe(1)

    expect((await authed(ctx.app, cookie, 'DELETE', `/api/v1/tasks/${a.id}`)).status).toBe(200)
    expect((await authed(ctx.app, cookie, 'DELETE', `/api/v1/tasks/${b.id}`)).status).toBe(200)

    const unAfter = await authed(ctx.app, cookie, 'GET', '/api/v1/tasks/unassigned')
    expect(unAfter.body.tasks.some((t) => t.id === a.id)).toBe(false)
    expect(overdueTasksOf(ctx.db, ctx.members.lead.id).some((t) => t.id === b.id)).toBe(false)
    const invAfter = tasksInventory(ctx.db, { projectId: p.id })
    expect(invAfter.text).not.toContain(a.title)
    expect(invAfter.text).not.toContain(b.title)
    expect(queryMetric(ctx.db, 'overdue_tasks', { groupBy: 'project' }).rows.find((r) => r.project === p.name).overdue).toBe(0)
    expect(queryMetric(ctx.db, 'unassigned_tasks', { groupBy: 'project' }).rows.find((r) => r.project === p.name)?.count ?? 0).toBe(0)
    const listAfter = await authed(ctx.app, cookie, 'GET', '/api/v1/projects')
    expect(listAfter.body.projects.find((x) => x.id === p.id).overdueTasks).toBe(0)
  })

  it('S36-6: Agent delete_task——write scope 走通并落双层审计；read scope 403；未知 id 404', async () => {
    const p = await mkProject('Agent 删除项目')
    const taskId = p.tasks[0].id
    // 成员 PAT（非管理员）write scope 即可删（与 web 同口径，D1）
    const login = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/agent-login', payload: { username: 'zhangsan', password: 'pass-123456' } })
    const writeToken = login.json().token

    const ok = await agent('POST', '/api/v1/agent/actions', { action: 'delete_task', params: { id: taskId } }, writeToken)
    expect(ok.status).toBe(200)
    expect(ok.body.ok).toBe(true)
    expect(ctx.db.prepare('SELECT deleted_at FROM tasks WHERE id = ?').get(taskId).deleted_at).toBeGreaterThan(0)
    // 双层审计：通道层 agent.action.delete_task + 引擎层 task.delete
    expect(ctx.db.prepare(`SELECT * FROM audit_logs WHERE action = 'agent.action.delete_task'`).get()).toBeTruthy()
    expect(ctx.db.prepare(`SELECT * FROM audit_logs WHERE action = 'task.delete' AND object_id = ?`).get(String(taskId))).toBeTruthy()

    const readLogin = await ctx.app.inject({
      method: 'POST', url: '/api/v1/auth/tokens', payload: { scope: 'read' },
      headers: { cookie: await loginCookie(ctx.app, 'zhangsan', 'pass-123456') },
    })
    const denied = await agent('POST', '/api/v1/agent/actions', { action: 'delete_task', params: { id: p.tasks[1].id } }, readLogin.json().token)
    expect(denied.status).toBe(403)

    const missing = await agent('POST', '/api/v1/agent/actions', { action: 'delete_task', params: { id: 999999 } }, writeToken)
    expect(missing.status).toBe(404)
  })

  it('S36-7: 已删任务的待确认建议确认 409，任务面不复活、事件保持 pending', async () => {
    const cookie = await admin()
    const p = await mkProject('建议不复活项目')
    const taskId = p.tasks[0].id
    const evt = await authed(ctx.app, cookie, 'POST', `/api/v1/projects/${p.id}/events`, {
      eventType: 'status_change', nature: 'suggestion', summary: '口述：任务已完成',
      targetTaskId: taskId, targetField: 'status', targetValue: 'done',
    })
    expect(evt.status).toBe(201)
    const eventId = evt.body.id

    expect((await authed(ctx.app, cookie, 'DELETE', `/api/v1/tasks/${taskId}`)).status).toBe(200)
    const confirm = await authed(ctx.app, cookie, 'POST', `/api/v1/events/${eventId}/confirm`)
    expect(confirm.status).toBe(409)
    expect(confirm.body.message).toContain('已删除')

    const row = ctx.db.prepare('SELECT status, deleted_at FROM tasks WHERE id = ?').get(taskId)
    expect(row.status).toBe('todo') // 不复活
    expect(row.deleted_at).toBeGreaterThan(0)
    expect(ctx.db.prepare('SELECT status FROM project_events WHERE id = ?').get(eventId).status).toBe('pending')
  })

  it('S36-8: 未登录调删除端点 401', async () => {
    const p = await mkProject('未登录项目')
    const res = await ctx.app.inject({ method: 'DELETE', url: `/api/v1/tasks/${p.tasks[0].id}` })
    expect(res.statusCode).toBe(401)
  })
})
