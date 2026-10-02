import { describe, it, expect, afterAll } from 'vitest'
import { setupApp, loginCookie, authed } from './helpers.mjs'
import { today } from '../db/time.js'
import { addEvent } from '../engine/events.js'
import { overdueTasksOf } from '../engine/tasks.js'
import { personDigest } from '../brain/digest.js'

// PRD S8 / S29 — 结项门禁与归档只读（v0.6：任务唯一终态=完成）；v0.28：结项/取消均必填原因文本、
// 取消原样冻结未完任务、终态不可逆、待确认建议批量过期、终态项目任务退出预警/梳理口径。

let ctx
afterAll(() => ctx?.db.close())

async function mkProject(ctx, cookie, name) {
  const res = await authed(ctx.app, cookie, 'POST', '/api/v1/projects', {
    name, templateCode: 'software_delivery', leadMemberId: ctx.members.lead.id,
  })
  return res.body
}

async function markAllDone(ctx, cookie, projectId) {
  const tasks = (await authed(ctx.app, cookie, 'GET', `/api/v1/projects/${projectId}`)).body.tasks
  for (const t of tasks) await authed(ctx.app, cookie, 'PATCH', `/api/v1/tasks/${t.id}`, { status: 'done' })
}

describe('S8 结项', () => {
  it('S8-1: 存在未完任务时应列出清单，全部标记完成后方可结项（v0.6 不再有「取消」处置）', async () => {
    ctx = await setupApp()
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const p = await mkProject(ctx, cookie, '客户F系统')
    const blocked = await authed(ctx.app, cookie, 'POST', `/api/v1/projects/${p.id}/close`, {})
    expect(blocked.status).toBe(409)
    expect(blocked.body.openTasks.length).toBe(6)
    expect(blocked.body.openTasks[0].title).toBeTruthy()

    // 旧 dispositions 入参已删除：即使传也不再豁免，规则只有「全部完成」
    const still = await authed(ctx.app, cookie, 'POST', `/api/v1/projects/${p.id}/close`, {
      dispositions: blocked.body.openTasks.map((t) => ({ taskId: t.id, action: 'cancelled' })),
    })
    expect(still.status).toBe(409)

    await markAllDone(ctx, cookie, p.id)
    const ok = await authed(ctx.app, cookie, 'POST', `/api/v1/projects/${p.id}/close`, { summary: '验收通过，客户确认上线' })
    expect(ok.status).toBe(200)
    expect(ok.body.status).toBe('closed')
    expect(ok.body.closeoutSummary).toContain('验收通过')
    expect(ok.body.actualEndDate).toBe(today())
    expect(ok.body.tasks.every((t) => t.status === 'done')).toBe(true)
    // 重复结项 409（终态不可逆）
    expect((await authed(ctx.app, cookie, 'POST', `/api/v1/projects/${p.id}/close`, { summary: 'x' })).status).toBe(409)
    // 已结项不可再取消（终态互斥）
    expect((await authed(ctx.app, cookie, 'POST', `/api/v1/projects/${p.id}/cancel`, { reason: 'x' })).status).toBe(409)
  })

  it('S8-2/S29-2: 结项摘要必填（空 400）；AI 复盘草稿端点只产草稿不关项目；结项后任务面只读、事件可追加', async () => {
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const p = await mkProject(ctx, cookie, '客户G系统')
    await markAllDone(ctx, cookie, p.id)
    // 任务全完成但无摘要 → 400（v0.28：结束必须留原因文本）
    const noSummary = await authed(ctx.app, cookie, 'POST', `/api/v1/projects/${p.id}/close`, {})
    expect(noSummary.status).toBe(400)
    expect(noSummary.body.message).toMatch(/总结|原因|摘要/)
    // AI 草稿端点：返回草稿文本，项目仍是进行中
    const draft = await authed(ctx.app, cookie, 'GET', `/api/v1/projects/${p.id}/closeout-draft`)
    expect(draft.status).toBe(200)
    expect(draft.body.summary).toBeTruthy()
    const still = await authed(ctx.app, cookie, 'GET', `/api/v1/projects/${p.id}`)
    expect(still.body.status).toBe('active')
    // 人工改后提交
    const closed = await authed(ctx.app, cookie, 'POST', `/api/v1/projects/${p.id}/close`, { summary: `${draft.body.summary}（人工修订）` })
    expect(closed.status).toBe(200)
    expect(closed.body.closeoutSummary).toContain('人工修订')
    // 任务面只读
    const taskPatch = await authed(ctx.app, cookie, 'PATCH', `/api/v1/tasks/${p.tasks[0].id}`, { status: 'doing' })
    expect(taskPatch.status).toBe(409)
    const newTask = await authed(ctx.app, cookie, 'POST', '/api/v1/tasks', { projectId: p.id, title: '补录' })
    expect(newTask.status).toBe(409)
    const events = await authed(ctx.app, cookie, 'GET', `/api/v1/projects/${p.id}/events`)
    expect(events.body.events.some((e) => e.summary.includes('结项'))).toBe(true)
  })
})

describe('S8-3 / S29 取消项目', () => {
  it('S8-3/S29-2: 取消原因必填；生效落实际结束日、计划中里程碑转已取消、任务面只读、留事件与审计', async () => {
    ctx = await setupApp()
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const p = await mkProject(ctx, cookie, '客户H系统')
    // 计划中里程碑
    ctx.db.prepare(`INSERT INTO milestones (project_id, name, plan_date, status, created_at, updated_at) VALUES (?, '验收节点', ?, 'planned', 1, 1)`)
      .run(p.id, today())
    // 原因必填
    const noReason = await authed(ctx.app, cookie, 'POST', `/api/v1/projects/${p.id}/cancel`, {})
    expect(noReason.status).toBe(400)
    expect(noReason.body.message).toMatch(/原因/)
    // 未完任务无需处置：直接取消
    const ok = await authed(ctx.app, cookie, 'POST', `/api/v1/projects/${p.id}/cancel`, { reason: '客户战略调整，项目终止' })
    expect(ok.status).toBe(200)
    expect(ok.body.status).toBe('cancelled')
    expect(ok.body.actualEndDate).toBe(today())
    expect(ok.body.closeoutSummary).toBe('客户战略调整，项目终止')
    // 未完任务原样冻结（不转完成、不转取消）
    expect(ok.body.tasks.some((t) => t.status === 'todo')).toBe(true)
    // 计划中里程碑转已取消
    expect(ok.body.milestones.every((m) => m.status === 'cancelled')).toBe(true)
    // 任务面只读
    const taskPatch = await authed(ctx.app, cookie, 'PATCH', `/api/v1/tasks/${p.tasks[0].id}`, { status: 'doing' })
    expect(taskPatch.status).toBe(409)
    // 事件 + 审计
    const events = await authed(ctx.app, cookie, 'GET', `/api/v1/projects/${p.id}/events`)
    const evt = events.body.events.find((e) => e.summary.includes('项目取消'))
    expect(evt).toBeTruthy()
    expect(evt.summary).toContain('客户战略调整')
    const audit = ctx.db.prepare(`SELECT * FROM audit_logs WHERE action = 'project.cancel' AND object_id = ?`).get(String(p.id))
    expect(audit).toBeTruthy()
    // 重复取消 409；已取消不可再结项（终态互斥）
    expect((await authed(ctx.app, cookie, 'POST', `/api/v1/projects/${p.id}/cancel`, { reason: 'x' })).status).toBe(409)
    expect((await authed(ctx.app, cookie, 'POST', `/api/v1/projects/${p.id}/close`, { summary: 'x' })).status).toBe(409)
  })

  it('S29-3: 终态不可逆（任何字段 PATCH 409）；待确认建议批量过期且不可再确认', async () => {
    ctx = await setupApp()
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const p = await mkProject(ctx, cookie, '客户I系统')
    const task = p.tasks[0]
    // 挂一条待确认建议（目标=任务状态）
    const sug = addEvent(ctx.db, {
      projectId: p.id, nature: 'suggestion', eventType: 'status_change', summary: '建议标记完成',
      sourcePlatform: 'brain', generatedBy: 'digest', targetTaskId: task.id, targetField: 'status', targetValue: 'done',
    })
    await authed(ctx.app, cookie, 'POST', `/api/v1/projects/${p.id}/cancel`, { reason: '终止' })
    // 待确认建议已批量过期
    const after = ctx.db.prepare('SELECT status FROM project_events WHERE id = ?').get(sug.id)
    expect(after.status).toBe('expired')
    // 确认口子同样拒（双保险：即便有新挂建议也不可在终态生效）
    const sug2 = addEvent(ctx.db, {
      projectId: p.id, nature: 'suggestion', eventType: 'status_change', summary: '建议标记完成2',
      sourcePlatform: 'brain', generatedBy: 'digest', targetTaskId: task.id, targetField: 'status', targetValue: 'done',
    })
    const confirm = await authed(ctx.app, cookie, 'POST', `/api/v1/events/${sug2.id}/confirm`)
    expect(confirm.status).toBe(409)
    // 终态项目任何字段 PATCH → 409
    for (const patch of [{ name: '改名' }, { priority: 'high' }, { planEndDate: '2030-01-01' }, { status: 'active' }]) {
      const denied = await authed(ctx.app, cookie, 'PATCH', `/api/v1/projects/${p.id}`, patch)
      expect(denied.status).toBe(409)
    }
  })

  it('S29-3: 终态项目的未完任务退出逾期预警与个人梳理口径', async () => {
    ctx = await setupApp()
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const p = await mkProject(ctx, cookie, '客户J系统')
    // 制造逾期未完任务（责任人=牵头人 lead）
    const task = p.tasks[0]
    await authed(ctx.app, cookie, 'PATCH', `/api/v1/tasks/${task.id}`, { planEndDate: '2020-01-01' })
    expect(overdueTasksOf(ctx.db, ctx.members.lead.id).some((t) => t.id === task.id)).toBe(true)
    await authed(ctx.app, cookie, 'POST', `/api/v1/projects/${p.id}/cancel`, { reason: '终止' })
    // 取消后不再计入逾期预警口径
    expect(overdueTasksOf(ctx.db, ctx.members.lead.id).some((t) => t.id === task.id)).toBe(false)
    // 个人梳理同样不再纳入
    const digest = await personDigest(ctx.db, ctx.members.lead.id)
    expect(digest.taskCount).toBe(0)
  })
})
