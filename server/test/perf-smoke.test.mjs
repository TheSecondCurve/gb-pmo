import { describe, it, expect, afterAll } from 'vitest'
import { setupApp, loginCookie, authed } from './helpers.mjs'
import { queryMetric, METRICS } from '../engine/metrics.js'
import { projectBrief } from '../engine/brief.js'
import { morningReport } from '../engine/morning.js'
import { today, addDays } from '../db/time.js'

// 【工程防线】数据量冒烟：50 项目 / 500 任务 / 5000 事件 / 20 成员下，指标端点与组装层不塌。
// 场景层全是小数据集（4 成员 + 个位数项目），本文件防「数据量上来后 N+1 / 全表扫」级别回归。
// 预算宽松（单项 < 500ms，CI 机器友好）——抓的是数量级恶化，不是毫秒级抖动。

const BUDGET_MS = 500

let ctx
afterAll(() => ctx?.db.close())

function seedBulk(db) {
  const t = today()
  const start = Date.now()
  const memberIds = []
  const projectIds = []
  db.exec('BEGIN')
  try {
    const insMember = db.prepare(
      `INSERT INTO members (name, username, password_hash, feishu_id, team, is_key_person, max_parallel_projects, role, status, created_at, updated_at)
       VALUES (?, ?, 'x', ?, '交付部', 0, 3, 'member', 'active', ?, ?)`
    )
    for (let i = 1; i <= 20; i++) {
      memberIds.push(Number(insMember.run(`成员${i}`, `bulk${i}`, `fs_bulk${i}`, start, start).lastInsertRowid))
    }
    const insProject = db.prepare(
      `INSERT INTO projects (name, status, priority, lead_member_id, plan_start_date, plan_end_date, actual_start_date, created_at, updated_at)
       VALUES (?, 'active', ?, ?, ?, ?, ?, ?, ?)`
    )
    const insTask = db.prepare(
      `INSERT INTO tasks (project_id, title, responsible_member_id, status, plan_start_date, plan_end_date, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'template', ?, ?)`
    )
    const insEvent = db.prepare(
      `INSERT INTO project_events (project_id, business_time, nature, event_type, summary, status, generated_by, created_at)
       VALUES (?, ?, 'record', 'progress', ?, 'effective', 'extraction', ?)`
    )
    for (let i = 1; i <= 50; i++) {
      const pid = Number(insProject.run(
        `批量项目${i}`, ['high', 'medium', 'low'][i % 3], memberIds[i % 20],
        t, addDays(t, 30 + (i % 10)), t, start, start
      ).lastInsertRowid)
      projectIds.push(pid)
    }
    for (const pid of projectIds) {
      for (let j = 1; j <= 10; j++) {
        insTask.run(pid, `任务${j}`, memberIds[j % 20], j % 3 === 0 ? 'done' : j % 3 === 1 ? 'doing' : 'todo',
          t, addDays(t, j % 4 === 0 ? -j : j * 2), start, start) // 1/4 逾期
      }
    }
    let day = 0
    for (let e = 0; e < 5000; e++) {
      const pid = projectIds[e % 50]
      insEvent.run(pid, start - (day++ % 30) * 86_400_000, `进展 ${e}`, start - (day % 30) * 86_400_000)
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  return projectIds
}

const timed = async (label, fn) => {
  const t0 = performance.now()
  const out = await fn()
  const ms = performance.now() - t0
  if (ms >= BUDGET_MS) console.warn(`  [perf] ${label}: ${ms.toFixed(1)}ms（预算 ${BUDGET_MS}ms）`)
  expect(ms).toBeLessThan(BUDGET_MS)
  return out
}

describe('数据量冒烟（50 项目 / 500 任务 / 5000 事件）', () => {
  it('播种 + 全指标端点 + 列表 + brief/晨报组装均在预算内', async () => {
    ctx = await setupApp()
    const projectIds = seedBulk(ctx.db)

    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    // 全 8 个指标经 HTTP 端点（dashboard 取数唯一入口）
    for (const m of METRICS) {
      const res = await timed(`metric ${m.id}`, () => authed(ctx.app, cookie, 'GET', `/api/v1/metrics/${m.id}/query`))
      expect(res.status).toBe(200)
    }
    // 组合页三态全量列表（S30 契约）
    const list = await timed('projects?status=all', () => authed(ctx.app, cookie, 'GET', '/api/v1/projects?status=active,closed,cancelled'))
    expect(list.body.projects.length).toBeGreaterThanOrEqual(50)
    // engine 组装层：单项目 brief + 全局晨报
    const brief = await timed('projectBrief', () => projectBrief(ctx.db, projectIds[0]))
    expect(brief.tasks.total).toBe(10)
    const morning = await timed('morningReport', () => morningReport(ctx.db, {}))
    expect(morning.text).toContain('批量项目')
    // 直调层口径抽查（与端点同源）：逾期口径 > 0
    expect(queryMetric(ctx.db, 'overdue_tasks', {}).rows.length).toBeGreaterThan(0)
  }, 30_000)
})
