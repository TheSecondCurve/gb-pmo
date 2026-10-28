import { describe, it, expect, afterAll } from 'vitest'
import { setupApp, loginCookie, authed } from './helpers.mjs'
import { queryMetric } from '../engine/metrics.js'
import { today, addDays } from '../db/time.js'

// PRD S5 + S2-3 — dashboard 与 Agent metrics 端点同源；优先级档位排序；逾期口径

let ctx
let pat
afterAll(() => ctx?.db.close())

describe('S5 全局 dashboard（指标同源）', () => {
  it('S5-1: 按优先级档位排序展示在跑项目，含健康度要素', async () => {
    ctx = await setupApp()
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    await authed(ctx.app, cookie, 'POST', '/api/v1/projects', {
      name: '低优项目', templateCode: 'lianmai_365', leadMemberId: ctx.members.dev.id, priority: 'low',
    })
    const high = await authed(ctx.app, cookie, 'POST', '/api/v1/projects', {
      name: '高优项目', templateCode: 'lianmai_365', leadMemberId: ctx.members.lead.id, priority: 'high',
    })
    // 高优项目造一个逾期任务（S2-3 口径）+ 一条旧事件（沉默）
    const yesterday = addDays(today(), -1) // S19：北京昨日（裸 toISOString 在北京 00:00–08:00 是前天）
    await authed(ctx.app, cookie, 'PATCH', `/api/v1/tasks/${high.body.tasks[0].id}`, { planEndDate: yesterday })
    await authed(ctx.app, cookie, 'POST', `/api/v1/projects/${high.body.id}/events`, { eventType: 'progress', summary: '早期进展' })
    ctx.db.prepare('UPDATE project_events SET business_time = ? WHERE project_id = ?').run(Date.now() - 10 * 86400000, high.body.id)

    const list = await authed(ctx.app, cookie, 'GET', '/api/v1/projects')
    expect(list.body.projects[0].name).toBe('高优项目')
    expect(list.body.projects.some((p) => p.name === '低优项目')).toBe(true)
    const hi = list.body.projects.find((p) => p.name === '高优项目')
    expect(hi.overdueTasks).toBeGreaterThanOrEqual(1)
    expect(hi.silentDays).toBeGreaterThanOrEqual(9)

    const health = queryMetric(ctx.db, 'project_health', { topN: 10 })
    const hiHealth = health.rows.find((r) => r.project === '高优项目')
    expect(hiHealth.health).toBe('red')
    expect(hiHealth.overdueTasks).toBeGreaterThanOrEqual(1)
  })

  it('S2-3: 计划结束日<今日且未完成的任务计入逾期指标（口径验证）', async () => {
    const r = queryMetric(ctx.db, 'overdue_tasks', { groupBy: 'project' })
    expect(r.rows.length).toBeGreaterThanOrEqual(1)
    expect(r.rows.some((x) => x.overdue >= 1)).toBe(true)
    expect(r.rows[0]).toHaveProperty('overdueRate')
  })

  it('S5-3: 同一指标 dashboard 与 Agent metrics 端点返回一致（口径同源）', async () => {
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const login = await ctx.app.inject({
      method: 'POST', url: '/api/v1/auth/agent-login', payload: { username: 'admin', password: 'admin-pass-123' },
    })
    pat = login.json().token

    for (const metric of ['running_projects', 'overdue_tasks', 'project_health', 'silent_projects', 'keyperson_load', 'weekly_project_flow', 'suggestion_acceptance', 'unassigned_tasks']) {
      const viaWeb = await authed(ctx.app, cookie, 'GET', `/api/v1/metrics/${metric}/query`)
      const viaAgent = await ctx.app.inject({
        method: 'POST', url: '/api/v1/agent/metrics/query', payload: { metric },
        headers: { authorization: `Bearer ${pat}` },
      })
      expect(viaAgent.statusCode).toBe(200)
      expect(viaAgent.json().rows).toEqual(viaWeb.body.rows)
    }
  })

  it('S5-3: 指标目录（定义卡）下发给 Agent', async () => {
    const cat = await ctx.app.inject({
      method: 'GET', url: '/api/v1/agent/metrics', headers: { authorization: `Bearer ${pat}` },
    })
    expect(cat.statusCode).toBe(200)
    const ids = cat.json().metrics.map((m) => m.id)
    expect(ids).toContain('project_health')
    expect(ids).toContain('suggestion_acceptance')
    expect(cat.json().metrics[0]).toHaveProperty('definition')
  })
})

describe('S5-5 终态项目退出指标口径（v0.79，K63）', () => {
  let ctx2
  afterAll(() => ctx2?.db.close())

  it('S5-5: 取消项目冻结任务不计逾期/未指派/负载；结项·取消不进在跑；无交付日期在跑项目照常计入', async () => {
    ctx2 = await setupApp()
    const cookie = await loginCookie(ctx2.app, 'admin', 'admin-pass-123')
    const yesterday = addDays(today(), -1)
    const base = { templateCode: 'lianmai_365', leadMemberId: ctx2.members.lead.id }

    // 在跑：无任何日期（「开口」项目，必须照常计入看板）
    const noDate = await authed(ctx2.app, cookie, 'POST', '/api/v1/projects', { ...base, name: '无日期在跑', tasks: [] })
    expect(noDate.status).toBe(201)
    // 在跑：一条有主逾期任务
    const overdue = await authed(ctx2.app, cookie, 'POST', '/api/v1/projects', { ...base, name: '有逾期在跑', tasks: ['逾期任务'] })
    await authed(ctx2.app, cookie, 'PATCH', `/api/v1/tasks/${overdue.body.tasks[0].id}`,
      { planEndDate: yesterday, responsibleMemberId: ctx2.members.lead.id })
    // 取消：两条冻结任务（甲=有主逾期；乙=未指派逾期）——冻结后退出指标口径（S29-3）
    const cancelled = await authed(ctx2.app, cookie, 'POST', '/api/v1/projects',
      { ...base, name: '取消冻结', tasks: ['冻结任务甲', '冻结任务乙'] })
    await authed(ctx2.app, cookie, 'PATCH', `/api/v1/tasks/${cancelled.body.tasks[0].id}`,
      { planEndDate: yesterday, responsibleMemberId: ctx2.members.lead.id })
    await authed(ctx2.app, cookie, 'PATCH', `/api/v1/tasks/${cancelled.body.tasks[1].id}`, { planEndDate: yesterday })
    const cx = await authed(ctx2.app, cookie, 'POST', `/api/v1/projects/${cancelled.body.id}/cancel`, { reason: '战略调整' })
    expect(cx.status).toBe(200)
    // 结项：空项目
    const closed = await authed(ctx2.app, cookie, 'POST', '/api/v1/projects', { ...base, name: '已结项项目', tasks: [] })
    await authed(ctx2.app, cookie, 'POST', `/api/v1/projects/${closed.body.id}/close`, { summary: '交付完成' })

    // 看板列表：仅进行中；无交付日期的在跑项目照常在列（daysToDelivery=null 也不丢）
    const list = await authed(ctx2.app, cookie, 'GET', '/api/v1/projects')
    const names = list.body.projects.map((p) => p.name)
    expect(names).toContain('无日期在跑')
    expect(names).toContain('有逾期在跑')
    expect(names).not.toContain('取消冻结')
    expect(names).not.toContain('已结项项目')
    const noDateRow = list.body.projects.find((p) => p.name === '无日期在跑')
    expect(noDateRow.daysToDelivery).toBeNull() // 无交付日期 ≠ 不展示（S21 口径：不派生天数但保留在列）

    // 在跑项目数：仅进行中（2），无日期项目计入
    const running = queryMetric(ctx2.db, 'running_projects', { groupBy: 'status' })
    expect(running.rows.reduce((s, r) => s + Number(r.count), 0)).toBe(2)

    // 逾期任务指标：只统计进行中项目——取消项目的冻结逾期任务退出
    const od = queryMetric(ctx2.db, 'overdue_tasks', { groupBy: 'project' })
    const odRows = od.rows.map((r) => r.project)
    expect(odRows).toContain('有逾期在跑')
    expect(odRows).not.toContain('取消冻结')
    expect(od.rows.reduce((s, r) => s + Number(r.overdue || 0), 0)).toBe(1)

    // 未指派指标：取消项目的冻结未指派任务退出
    const un = queryMetric(ctx2.db, 'unassigned_tasks', { groupBy: 'project' })
    expect(un.rows.map((r) => r.project)).not.toContain('取消冻结')

    // 关键人负载：open_tasks 只数进行中项目的未完任务（冻结任务不计）
    const load = queryMetric(ctx2.db, 'keyperson_load', { groupBy: 'member' })
    const zhang = load.rows.find((r) => r.member === '张三')
    expect(zhang.openTasks).toBe(1)
    expect(zhang.parallelProjects).toBe(2) // 牵头两个在跑（取消项目本就不计）
  })
})
