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

  it('S1-2: 软件交付类型立项 → 按绑定模板生成扁平任务清单，任务责任人默认=牵头人（v0.6 无阶段层）', async () => {
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const res = await authed(ctx.app, cookie, 'POST', '/api/v1/projects', {
      name: '客户A系统', templateCode: 'software_delivery', leadMemberId: ctx.members.lead.id,
      priority: 'high', planEndDate: '2026-12-31',
    })
    expect(res.status).toBe(201)
    const detail = res.body
    expect(detail.status).toBe('planning')
    expect(detail.stages).toBeUndefined()
    expect(detail.tasks.length).toBe(6)
    expect(detail.tasks.map((t) => t.title)).toContain('需求确认与范围冻结')
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

  it('S1-4: 自由创建 → 不含任务的空项目，支持随时添加任务（v0.6）', async () => {
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const res = await authed(ctx.app, cookie, 'POST', '/api/v1/projects', {
      name: '内部优化', templateCode: 'custom', leadMemberId: ctx.members.dev.id,
    })
    expect(res.status).toBe(201)
    expect(res.body.stages).toBeUndefined()
    expect(res.body.tasks).toHaveLength(0)
    const add = await authed(ctx.app, cookie, 'POST', '/api/v1/tasks', { projectId: res.body.id, title: '梳理现状' })
    expect(add.status).toBe(201)
    expect(add.body.title).toBe('梳理现状')
    expect(add.body.status).toBe('todo')
  })

  it('S1-5: 按项目类型立项 → 自动套用该类型绑定的默认模板，记录类型与模板快照', async () => {
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const res = await authed(ctx.app, cookie, 'POST', '/api/v1/projects', {
      name: '类型立项E', typeCode: 'software_delivery', leadMemberId: ctx.members.lead.id,
    })
    expect(res.status).toBe(201)
    expect(res.body.templateCode).toBe('software_delivery')
    expect(res.body.projectTypeId).toBeGreaterThan(0)
    expect(res.body.typeName).toBe('软件交付')
    expect(res.body.stages).toBeUndefined()
    expect(res.body.tasks.every((t) => t.responsibleMemberId === ctx.members.lead.id)).toBe(true)
    // 兼容：仍可直接给 templateCode（Agent/旧调用），类型留空
    const legacy = await authed(ctx.app, cookie, 'POST', '/api/v1/projects', {
      name: '旧入参立项F', templateCode: 'consulting', leadMemberId: ctx.members.dev.id,
    })
    expect(legacy.status).toBe(201)
    expect(legacy.body.templateCode).toBe('consulting')
    expect(legacy.body.projectTypeId).toBeNull()
  })
})

describe('S2 排期与任务维护', () => {
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

  it('S2-2: 【已废弃 v0.6】任务间前置依赖整体裁剪：旧入参与状态值一律 400', async () => {
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const p = await authed(ctx.app, cookie, 'POST', '/api/v1/projects', {
      name: '客户D交付', templateCode: 'software_delivery', leadMemberId: ctx.members.lead.id,
    })
    const task = p.body.tasks[0]
    // 依赖端点已删除 → 404
    const dep = await authed(ctx.app, cookie, 'POST', '/api/v1/dependencies', { taskId: task.id, dependsOnTaskId: p.body.tasks[1].id })
    expect(dep.status).toBe(404)
    // 状态固定三档：blocked/cancelled → 400
    const bad1 = await authed(ctx.app, cookie, 'PATCH', `/api/v1/tasks/${task.id}`, { status: 'blocked' })
    expect(bad1.status).toBe(400)
    const bad2 = await authed(ctx.app, cookie, 'PATCH', `/api/v1/tasks/${task.id}`, { status: 'cancelled' })
    expect(bad2.status).toBe(400)
  })

  it('S2-3: 任务更新记录可不停追加且历史不可改；结项归档后任务面（含记录）只读', async () => {
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const p = await authed(ctx.app, cookie, 'POST', '/api/v1/projects', {
      name: '客户F交付', templateCode: 'software_delivery', leadMemberId: ctx.members.lead.id,
    })
    const task = p.body.tasks[0]
    const r1 = await authed(ctx.app, cookie, 'POST', `/api/v1/tasks/${task.id}/records`, { content: '完成范围冻结，待评审' })
    expect(r1.status).toBe(201)
    expect(r1.body.record.content).toContain('范围冻结')
    await authed(ctx.app, cookie, 'POST', `/api/v1/tasks/${task.id}/records`, { content: '评审通过' })
    const list = await authed(ctx.app, cookie, 'GET', `/api/v1/tasks/${task.id}/records`)
    expect(list.status).toBe(200)
    expect(list.body.records).toHaveLength(2)
    expect(list.body.records.map((r) => r.content)).toEqual(['完成范围冻结，待评审', '评审通过'])
    expect(list.body.records[0].memberName).toBe('管理员')
    // 空内容 / 不存在任务
    expect((await authed(ctx.app, cookie, 'POST', `/api/v1/tasks/${task.id}/records`, { content: '' })).status).toBe(400)
    expect((await authed(ctx.app, cookie, 'POST', '/api/v1/tasks/999/records', { content: 'x' })).status).toBe(404)
    // 结项归档后只读：先全部完成再结项，追加记录应 409
    for (const t of p.body.tasks) await authed(ctx.app, cookie, 'PATCH', `/api/v1/tasks/${t.id}`, { status: 'done' })
    const closed = await authed(ctx.app, cookie, 'POST', `/api/v1/projects/${p.body.id}/close`, { summary: '交付完成' })
    expect(closed.status).toBe(200)
    const after = await authed(ctx.app, cookie, 'POST', `/api/v1/tasks/${task.id}/records`, { content: '不应成功' })
    expect(after.status).toBe(409)
    // 历史记录仍可读
    const list2 = await authed(ctx.app, cookie, 'GET', `/api/v1/tasks/${task.id}/records`)
    expect(list2.body.records).toHaveLength(2)
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
