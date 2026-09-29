import { describe, it, expect, afterAll } from 'vitest'
import { setupApp, loginCookie, authed } from './helpers.mjs'

// PRD S8 — 结项门禁与归档只读

let ctx
afterAll(() => ctx?.db.close())

async function mkProject(ctx, cookie, name) {
  const res = await authed(ctx.app, cookie, 'POST', '/api/v1/projects', {
    name, templateCode: 'software_delivery', leadMemberId: ctx.members.lead.id,
  })
  return res.body
}

describe('S8 结项', () => {
  it('S8-1: 存在未完任务时应列出清单，逐项处置后方可结项', async () => {
    ctx = await setupApp()
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const p = await mkProject(ctx, cookie, '客户F系统')
    const blocked = await authed(ctx.app, cookie, 'POST', `/api/v1/projects/${p.id}/close`, { dispositions: [] })
    expect(blocked.status).toBe(409)
    expect(blocked.body.openTasks.length).toBe(6)
    expect(blocked.body.openTasks[0].title).toBeTruthy()

    const dispositions = blocked.body.openTasks.map((t, i) => ({ taskId: t.id, action: i < 2 ? 'done' : 'cancelled' }))
    const ok = await authed(ctx.app, cookie, 'POST', `/api/v1/projects/${p.id}/close`, {
      dispositions, summary: '验收通过，客户确认上线',
    })
    expect(ok.status).toBe(200)
    expect(ok.body.status).toBe('closed')
    expect(ok.body.closeoutSummary).toContain('验收通过')
    expect(ok.body.tasks.every((t) => t.status === 'done' || t.status === 'cancelled')).toBe(true)
  })

  it('S8-2: 结项后项目任务面转只读，事件流可追加（复盘留痕）', async () => {
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const p = await mkProject(ctx, cookie, '客户G系统')
    const open = (await authed(ctx.app, cookie, 'GET', `/api/v1/projects/${p.id}`)).body.tasks
    await authed(ctx.app, cookie, 'POST', `/api/v1/projects/${p.id}/close`, {
      dispositions: open.map((t) => ({ taskId: t.id, action: 'cancelled' })),
    })
    const taskPatch = await authed(ctx.app, cookie, 'PATCH', `/api/v1/tasks/${open[0].id}`, { status: 'doing' })
    expect(taskPatch.status).toBe(409)
    const newTask = await authed(ctx.app, cookie, 'POST', '/api/v1/tasks', { projectId: p.id, title: '补录' })
    expect(newTask.status).toBe(409)
    const events = await authed(ctx.app, cookie, 'GET', `/api/v1/projects/${p.id}/events`)
    expect(events.body.events.some((e) => e.summary.includes('结项'))).toBe(true)
  })
})
