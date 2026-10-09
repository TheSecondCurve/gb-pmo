import { describe, it, expect, afterAll } from 'vitest'
import { setupApp, loginCookie, authed } from './helpers.mjs'

// PRD S43-1（v0.44）— 项目组合页任务进度条的数据契约：
// listProjects 行属性新增 tasksTotal/tasksDone（仿 overdueTasks 子查询模式，排除软删任务）；
// 行级派生属性，非指标口径（metrics.js 不动），决策见 design.md K23。

let ctx
afterAll(() => ctx?.db.close())

describe('S43 项目组合页任务进度数据契约', () => {
  it('S43-1: listProjects 返回 tasksTotal/tasksDone——软删不计入、空项目 0/0、终态项目同口径', async () => {
    ctx = await setupApp()
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const base = { templateCode: 'lianmai_365', leadMemberId: ctx.members.lead.id }

    // 项目甲：4 任务，1 完成、1 进行中、1 软删 → total=3 / done=1
    const a = await authed(ctx.app, cookie, 'POST', '/api/v1/projects', { ...base, name: '项目甲', tasks: ['甲一', '甲二', '甲三', '甲四'] })
    expect(a.status).toBe(201)
    const detailA = await authed(ctx.app, cookie, 'GET', `/api/v1/projects/${a.body.id}`)
    const [t1, t2, t3] = detailA.body.tasks
    expect((await authed(ctx.app, cookie, 'PATCH', `/api/v1/tasks/${t1.id}`, { status: 'done' })).status).toBe(200)
    expect((await authed(ctx.app, cookie, 'PATCH', `/api/v1/tasks/${t2.id}`, { status: 'doing' })).status).toBe(200)
    expect((await authed(ctx.app, cookie, 'DELETE', `/api/v1/tasks/${t3.id}`)).status).toBe(200) // S36 软删

    // 项目乙：无任务 → 0/0
    const b = await authed(ctx.app, cookie, 'POST', '/api/v1/projects', { ...base, name: '项目乙', tasks: [] })
    expect(b.status).toBe(201)

    // 项目丙：1 任务完成后结项 → 终态同口径 1/1
    const c = await authed(ctx.app, cookie, 'POST', '/api/v1/projects', { ...base, name: '项目丙', tasks: ['丙一'] })
    const detailC = await authed(ctx.app, cookie, 'GET', `/api/v1/projects/${c.body.id}`)
    await authed(ctx.app, cookie, 'PATCH', `/api/v1/tasks/${detailC.body.tasks[0].id}`, { status: 'done' })
    expect((await authed(ctx.app, cookie, 'POST', `/api/v1/projects/${c.body.id}/close`, { summary: '交付完成' })).status).toBe(200)

    const all = await authed(ctx.app, cookie, 'GET', '/api/v1/projects?status=active,closed,cancelled')
    expect(all.status).toBe(200)
    const byName = Object.fromEntries(all.body.projects.map((p) => [p.name, p]))
    expect(byName['项目甲'].tasksTotal).toBe(3) // 软删的甲三不计入
    expect(byName['项目甲'].tasksDone).toBe(1)
    expect(byName['项目乙'].tasksTotal).toBe(0)
    expect(byName['项目乙'].tasksDone).toBe(0)
    expect(byName['项目丙'].tasksTotal).toBe(1)
    expect(byName['项目丙'].tasksDone).toBe(1)
  })
})
