// S49（v0.54，K32）：老板周报——组合级简报的确定性数据组装（北京时区，口径与指标层同源）。
// 零 LLM（综述段由 brain/digest.js 可选附加）； sections 为空时正文明示而非省略（与 S6-2 同则）。

import { camelizeRows } from '../db/index.mjs'
import { today, addDays, bjWeekStartMs, dayDiff, DAY_MS } from '../db/time.js'
import { getSetting } from './settings.js'
import { queryMetric } from './metrics.js'

export function weeklyBrief(db, { now = Date.now() } = {}) {
  const weekStartMs = bjWeekStartMs(now)
  const weekStartDay = today(weekStartMs)
  const todayDay = today(now)
  const th = getSetting(db, 'thresholds')

  // 本周新增 / 结项（weekly_project_flow 口径：立项 created_at / 结项 actual_end_date 落在本自然周）
  const started = camelizeRows(
    db.prepare('SELECT id, name FROM projects WHERE created_at >= ? ORDER BY created_at').all(weekStartMs)
  )
  const closed = camelizeRows(
    db.prepare(`SELECT id, name, status FROM projects WHERE actual_end_date >= ? AND actual_end_date <= ? ORDER BY actual_end_date`).all(weekStartDay, todayDay)
  )

  // 逾期项目清单（overdue_tasks by project 口径）
  const overdue = camelizeRows(
    db.prepare(
      `SELECT p.id, p.name, COUNT(*) AS overdue_count FROM tasks t JOIN projects p ON p.id = t.project_id
       WHERE p.status = 'active' AND t.status != 'done' AND t.deleted_at IS NULL
         AND t.plan_end_date IS NOT NULL AND t.plan_end_date < ?
       GROUP BY p.id ORDER BY overdue_count DESC`
    ).all(todayDay)
  )

  // 沉默项目清单（silent_projects 口径：最近已生效事件（无则立项时刻）早于 silentDays 天前）
  const silentCutoff = now - th.silentDays * DAY_MS
  const silent = camelizeRows(
    db.prepare(
      `SELECT p.id, p.name, COALESCE(
         (SELECT MAX(e.business_time) FROM project_events e WHERE e.project_id = p.id AND e.status = 'effective'),
         p.created_at) AS anchor
       FROM projects p WHERE p.status = 'active'`
    ).all()
  )
    .filter((p) => p.anchor < silentCutoff)
    .map((p) => ({ id: p.id, name: p.name, silentDays: Math.floor((now - p.anchor) / DAY_MS) }))

  // 未来 14 天交付临近（在跑项目交付日期落窗口内）
  const upcoming = camelizeRows(
    db.prepare(
      `SELECT id, name, plan_end_date FROM projects
       WHERE status = 'active' AND plan_end_date IS NOT NULL AND plan_end_date >= ? AND plan_end_date <= ?
       ORDER BY plan_end_date`
    ).all(todayDay, addDays(todayDay, 14))
  ).map((p) => ({ id: p.id, name: p.name, planEndDate: p.planEndDate, remainingDays: dayDiff(todayDay, p.planEndDate) }))

  // 关键人过载（keyperson_load 指标口径）
  const overloaded = queryMetric(db, 'keyperson_load', { groupBy: 'member' }).rows.filter((r) => r.overloaded)

  const lines = [`本周新增 ${started.length} 个${started.length ? `（${started.map((p) => p.name).join('、')}）` : ''}；结项/取消 ${closed.length} 个${closed.length ? `（${closed.map((p) => p.name).join('、')}）` : ''}`]
  lines.push(overdue.length
    ? `逾期项目 ${overdue.length} 个：\n${overdue.map((p) => `- ${p.name}（${p.overdueCount} 项逾期）`).join('\n')}`
    : '逾期项目：无')
  lines.push(silent.length
    ? `沉默项目 ${silent.length} 个：\n${silent.map((p) => `- ${p.name}（${p.silentDays} 天无动静）`).join('\n')}`
    : '沉默项目：无')
  lines.push(upcoming.length
    ? `未来 14 天交付：\n${upcoming.map((p) => `- ${p.name}（${p.planEndDate}，剩 ${p.remainingDays} 天）`).join('\n')}`
    : '未来 14 天交付：无')
  lines.push(overloaded.length
    ? `关键人过载：${overloaded.map((r) => `${r.member}（并行 ${r.parallelProjects}/${r.maxParallelProjects}）`).join('、')}`
    : '关键人过载：无')
  return { weekStart: weekStartDay, started, closed, overdue, silent, upcoming, overloaded, text: lines.join('\n\n') }
}
