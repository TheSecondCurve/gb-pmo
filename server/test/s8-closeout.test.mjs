import { describe, it, expect, afterAll } from 'vitest'
import { setupApp, loginCookie, authed } from './helpers.mjs'

// PRD S8 — 结项门禁与归档只读（v0.6：任务唯一终态=完成，未完任务全部标记完成后方可结项）

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
    expect(ok.body.tasks.every((t) => t.status === 'done')).toBe(true)
    // 重复结项 409
    expect((await authed(ctx.app, cookie, 'POST', `/api/v1/projects/${p.id}/close`, {})).status).toBe(409)
  })

  it('S8-2: 结项后项目任务面转只读，事件流可追加（复盘留痕）', async () => {
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const p = await mkProject(ctx, cookie, '客户G系统')
    await markAllDone(ctx, cookie, p.id)
    await authed(ctx.app, cookie, 'POST', `/api/v1/projects/${p.id}/close`, {})
    const open = p // mkProject 返回的 body 含 tasks（id 可用）
    const taskPatch = await authed(ctx.app, cookie, 'PATCH', `/api/v1/tasks/${open.tasks[0].id}`, { status: 'doing' })
    expect(taskPatch.status).toBe(409)
    const newTask = await authed(ctx.app, cookie, 'POST', '/api/v1/tasks', { projectId: p.id, title: '补录' })
    expect(newTask.status).toBe(409)
    const events = await authed(ctx.app, cookie, 'GET', `/api/v1/projects/${p.id}/events`)
    expect(events.body.events.some((e) => e.summary.includes('结项'))).toBe(true)
  })
})
