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

  it('S1-5: 按项目类型立项 → 记录类型编码快照与类型外键（v0.18：清单内嵌于类型）；templateCode 兼容别名同码解析', async () => {
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
    // 兼容：templateCode 直给按同码类型解析（Agent/旧调用）
    const legacy = await authed(ctx.app, cookie, 'POST', '/api/v1/projects', {
      name: '旧入参立项F', templateCode: 'consulting', leadMemberId: ctx.members.dev.id,
    })
    expect(legacy.status).toBe(201)
    expect(legacy.body.templateCode).toBe('consulting')
    expect(legacy.body.projectTypeId).toBeGreaterThan(0)
  })

  it('S1-6: 立项载荷显式给 tasks → 覆盖类型预填实例化（来源=手填）；空清单=空项目；空白标题 400', async () => {
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    // 字符串数组与 {title} 对象均可
    const res = await authed(ctx.app, cookie, 'POST', '/api/v1/projects', {
      name: '自定义任务G', typeCode: 'software_delivery', leadMemberId: ctx.members.lead.id,
      tasks: ['现场调研', { title: '部署方案评审' }, '割接上线'],
    })
    expect(res.status).toBe(201)
    expect(res.body.tasks.map((t) => t.title)).toEqual(['现场调研', '部署方案评审', '割接上线'])
    expect(res.body.tasks.every((t) => t.source === 'manual')).toBe(true)
    expect(res.body.tasks.every((t) => t.responsibleMemberId === ctx.members.lead.id)).toBe(true)
    // 空清单 → 空项目（即使类型有预填清单）
    const empty = await authed(ctx.app, cookie, 'POST', '/api/v1/projects', {
      name: '空清单H', typeCode: 'software_delivery', leadMemberId: ctx.members.dev.id, tasks: [],
    })
    expect(empty.status).toBe(201)
    expect(empty.body.tasks).toHaveLength(0)
    // 空白标题 → 400
    const bad = await authed(ctx.app, cookie, 'POST', '/api/v1/projects', {
      name: '坏清单I', typeCode: 'software_delivery', leadMemberId: ctx.members.dev.id, tasks: ['有效标题', '   '],
    })
    expect(bad.status).toBe(400)
  })

  it('S1-7: 倒排——autoSchedule + 交付日期 → 均分填任务计划起止（末条=交付日期）；缺交付日期 400；预览端点同公式', async () => {
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    // 缺交付日期 → 400
    const noEnd = await authed(ctx.app, cookie, 'POST', '/api/v1/projects', {
      name: '无期倒排J', typeCode: 'software_delivery', leadMemberId: ctx.members.lead.id, autoSchedule: true,
    })
    expect(noEnd.status).toBe(400)

    // 4 条任务、10-01 → 10-05（总 4 天）：due=02/03/04/05，start=01/03/04/05
    const res = await authed(ctx.app, cookie, 'POST', '/api/v1/projects', {
      name: '倒排项目K', typeCode: 'software_delivery', leadMemberId: ctx.members.lead.id,
      tasks: ['任务一', '任务二', '任务三', '任务四'],
      planStartDate: '2026-10-01', planEndDate: '2026-10-05', autoSchedule: true,
    })
    expect(res.status).toBe(201)
    const pick = (t) => ({ s: t.planStartDate, e: t.planEndDate })
    expect(res.body.tasks.map(pick)).toEqual([
      { s: '2026-10-01', e: '2026-10-02' }, { s: '2026-10-03', e: '2026-10-03' },
      { s: '2026-10-04', e: '2026-10-04' }, { s: '2026-10-05', e: '2026-10-05' },
    ])

    // 未给 planStartDate → 锚定今天（北京日）；末条截止仍=交付日期
    const anchorToday = await authed(ctx.app, cookie, 'POST', '/api/v1/projects', {
      name: '今天锚定L', typeCode: 'software_delivery', leadMemberId: ctx.members.lead.id,
      tasks: ['甲', '乙'], planEndDate: '2030-12-31', autoSchedule: true,
    })
    expect(anchorToday.status).toBe(201)
    expect(anchorToday.body.tasks.at(-1).planEndDate).toBe('2030-12-31')
    expect(anchorToday.body.tasks.every((t) => t.planStartDate && t.planEndDate)).toBe(true)

    // 窗口短于任务数：日期钳制（start 不晚于 due），不报错
    const tight = await authed(ctx.app, cookie, 'POST', '/api/v1/projects', {
      name: '紧凑倒排M', typeCode: 'software_delivery', leadMemberId: ctx.members.lead.id,
      tasks: ['a', 'b', 'c', 'd', 'e'], planStartDate: '2026-10-01', planEndDate: '2026-10-02', autoSchedule: true,
    })
    expect(tight.status).toBe(201)
    for (const t of tight.body.tasks) expect(t.planStartDate <= t.planEndDate).toBe(true)

    // 预览端点：同一公式、不落库
    const prev = await authed(ctx.app, cookie, 'POST', '/api/v1/projects/preview-schedule', {
      planStartDate: '2026-10-01', planEndDate: '2026-10-05', count: 4,
    })
    expect(prev.status).toBe(200)
    expect(prev.body.schedule).toEqual([
      { planStartDate: '2026-10-01', planEndDate: '2026-10-02' }, { planStartDate: '2026-10-03', planEndDate: '2026-10-03' },
      { planStartDate: '2026-10-04', planEndDate: '2026-10-04' }, { planStartDate: '2026-10-05', planEndDate: '2026-10-05' },
    ])
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
