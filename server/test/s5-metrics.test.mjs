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
