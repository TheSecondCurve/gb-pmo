import { describe, it, expect, afterAll } from 'vitest'
import { setupApp, loginCookie, authed } from './helpers.mjs'

// PRD S1 / S2 / S5-2 — 立项（模板+自由创建+牵头人）、排期与依赖、优先级变更留痕

let ctx
afterAll(() => ctx?.db.close())

describe('S1 立项', () => {
  it('S1-1: 当立项未指定牵头人时，应阻止完成立项', async () => {
    ctx = await setupApp()
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const res = await authed(ctx.app, cookie, 'POST', '/api/v1/projects', { name: '客户A系统', templateCode: 'software_delivery' })
    expect(res.status).toBe(400)
    expect(res.body.message).toContain('牵头人')
  })

  it('S1-2: 软件交付模板立项 → 默认阶段+任务清单，任务责任人默认=牵头人', async () => {
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const res = await authed(ctx.app, cookie, 'POST', '/api/v1/projects', {
      name: '客户A系统', templateCode: 'software_delivery', leadMemberId: ctx.members.lead.id,
      priority: 'high', planEndDate: '2026-12-31',
    })
    expect(res.status).toBe(201)
    const detail = res.body
    expect(detail.status).toBe('planning')
    expect(detail.stages.map((s) => s.name)).toEqual(['启动', '需求', '开发', '测试', '验收', '结项'])
    expect(detail.tasks.length).toBe(6)
    expect(detail.tasks.every((t) => t.responsibleMemberId === ctx.members.lead.id)).toBe(true)
    expect(detail.tasks.every((t) => t.source === 'template')).toBe(true)
  })

  it('S1-3: 未绑定核心渠道的项目计入管理员待办视图', async () => {
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    await authed(ctx.app, cookie, 'POST', '/api/v1/projects', {
      name: '客户B小程序', templateCode: 'software_delivery', leadMemberId: ctx.members.lead.id,
    })
    const todo = await authed(ctx.app, cookie, 'GET', '/api/v1/admin/todo')
    expect(todo.status).toBe(200)
    expect(todo.body.projects.map((p) => p.name)).toContain('客户B小程序')
    // 绑定专题渠道后从待办消失
    const target = todo.body.projects.find((p) => p.name === '客户B小程序')
    await authed(ctx.app, cookie, 'POST', '/api/v1/channels', {
      platform: 'feishu', groupKey: 'oc_customer_b', channelType: 'dedicated', projectId: target.id,
    })
    const todo2 = await authed(ctx.app, cookie, 'GET', '/api/v1/admin/todo')
    expect(todo2.body.projects.map((p) => p.name)).not.toContain('客户B小程序')
  })

  it('S1-4: 自由创建 → 仅含「启动」「结项」两个锚点阶段，可追加阶段', async () => {
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const res = await authed(ctx.app, cookie, 'POST', '/api/v1/projects', {
      name: '内部优化', templateCode: 'custom', leadMemberId: ctx.members.dev.id,
    })
    expect(res.status).toBe(201)
    expect(res.body.stages.map((s) => s.name)).toEqual(['启动', '结项'])
    expect(res.body.tasks).toHaveLength(0)
    const add = await authed(ctx.app, cookie, 'POST', `/api/v1/projects/${res.body.id}/stages`, { name: '梳理' })
    expect(add.status).toBe(201)
    expect(add.body.name).toBe('梳理')
  })
})

describe('S2 排期与依赖', () => {
  it('S2-1: 责任人留空且设了计划开始日 → 进未指派视图', async () => {
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const p = await authed(ctx.app, cookie, 'POST', '/api/v1/projects', {
      name: '客户C交付', templateCode: 'software_delivery', leadMemberId: ctx.members.lead.id,
    })
    const task = p.body.tasks[0]
    await authed(ctx.app, cookie, 'PATCH', `/api/v1/tasks/${task.id}`, { responsibleMemberId: '', planStartDate: '2026-09-01' })
    const un = await authed(ctx.app, cookie, 'GET', '/api/v1/tasks/unassigned')
    expect(un.body.tasks.some((t) => t.id === task.id)).toBe(true)
  })

  it('S2-2: 前置任务未完成 → 后继任务标记「被阻塞」', async () => {
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const p = await authed(ctx.app, cookie, 'POST', '/api/v1/projects', {
      name: '客户D交付', templateCode: 'software_delivery', leadMemberId: ctx.members.lead.id,
    })
    const [a, b] = p.body.tasks
    await authed(ctx.app, cookie, 'PATCH', `/api/v1/tasks/${b.id}`, { dependsOnTaskId: a.id })
    const after = await authed(ctx.app, cookie, 'GET', `/api/v1/projects/${p.body.id}`)
    const bRow = after.body.tasks.find((t) => t.id === b.id)
    expect(bRow.isBlocked).toBe(true)
    // 前置完成后解除阻塞
    await authed(ctx.app, cookie, 'PATCH', `/api/v1/tasks/${a.id}`, { status: 'done' })
    const after2 = await authed(ctx.app, cookie, 'GET', `/api/v1/projects/${p.body.id}`)
    expect(after2.body.tasks.find((t) => t.id === b.id).isBlocked).toBe(false)
  })

  it('S5-2: 优先级调整立即生效并留事件痕迹', async () => {
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const p = await authed(ctx.app, cookie, 'POST', '/api/v1/projects', {
      name: '客户E咨询', templateCode: 'consulting', leadMemberId: ctx.members.lead.id, priority: 'low',
    })
    const upd = await authed(ctx.app, cookie, 'PATCH', `/api/v1/projects/${p.body.id}`, { priority: 'high' })
    expect(upd.body.priority).toBe('high')
    const events = await authed(ctx.app, cookie, 'GET', `/api/v1/projects/${p.body.id}/events`)
    const trace = events.body.events.find((e) => e.eventType === 'priority_change')
    expect(trace).toBeTruthy()
    expect(trace.summary).toContain('low → high')
  })
})
