// S53（v0.58，K36）：高频问询的确定性组装（零 LLM）——/my /week /risk 斜杠命令的数据源。
// 口径与既有引擎/指标层同源（pendingSuggestionsFor / keyperson_load / S48 沉默口径），不另起炉灶。

import { camelizeRows } from '../db/index.mjs'
import { today, addDays, bjWeekStartMs, dayDiff, DAY_MS } from '../db/time.js'
import { getSetting } from './settings.js'
import { pendingSuggestionsFor } from './events.js'
import { queryMetric } from './metrics.js'
import { label } from './enums.js'

/** /my：本人未完任务（逾期标注）+ 明日到期 + 待确认建议计数（跨在跑项目聚合）。 */
export function myWork(db, memberId) {
  const tasks = camelizeRows(
    db.prepare(
      `SELECT t.id, t.title, t.status, t.plan_end_date, p.name AS project_name FROM tasks t
       JOIN projects p ON p.id = t.project_id
       WHERE t.responsible_member_id = ? AND t.status != 'done' AND t.deleted_at IS NULL AND p.status = 'active'
       ORDER BY t.plan_end_date IS NULL, t.plan_end_date`
    ).all(memberId)
  )
  const todayDay = today()
  const tomorrow = addDays(todayDay, 1)
  const overdueCount = tasks.filter((t) => t.planEndDate && t.planEndDate < todayDay).length
  const dueTomorrow = tasks.filter((t) => t.planEndDate === tomorrow)
  const pending = pendingSuggestionsFor(db, memberId)
  const lines = tasks.map((t) => {
    const od = t.planEndDate && t.planEndDate < todayDay ? `（逾期 ${dayDiff(t.planEndDate, todayDay)} 天）` : ''
    return `- ${t.projectName} #${t.id} ${t.title} [${label('taskStatus', t.status)}]${t.planEndDate ? ` 截止 ${t.planEndDate}` : ''}${od}`
  })
  const sections = [`未完任务 ${tasks.length} 项${overdueCount ? `（逾期 ${overdueCount}）` : ''}：`, lines.join('\n') || '（无未完任务）']
  if (dueTomorrow.length) sections.push(`明日到期：${dueTomorrow.map((t) => `「${t.title}」`).join('、')}`)
  if (pending.length) sections.push(`待确认建议 ${pending.length} 条等你处理（web 项目详情页可一键批量）`)
  return { taskCount: tasks.length, overdueCount, dueTomorrow, pendingCount: pending.length, text: sections.join('\n') }
}

/** /week：本北京自然周（周一~周日）到期任务与计划中里程碑；定域=单项目或全部在跑项目。 */
export function weekAhead(db, { projectId = null, now = Date.now() } = {}) {
  const mondayMs = bjWeekStartMs(now)
  const monday = today(mondayMs)
  const sunday = addDays(monday, 6)
  const scope = projectId ? 'AND p.id = ?' : ''
  const args = projectId ? [monday, sunday, projectId] : [monday, sunday]
  const tasks = camelizeRows(
    db.prepare(
      `SELECT t.id, t.title, t.plan_end_date, p.name AS project_name, m.name AS owner FROM tasks t
       JOIN projects p ON p.id = t.project_id LEFT JOIN members m ON m.id = t.responsible_member_id
       WHERE p.status = 'active' AND t.status != 'done' AND t.deleted_at IS NULL
         AND t.plan_end_date >= ? AND t.plan_end_date <= ? ${scope}
       ORDER BY t.plan_end_date`
    ).all(...args)
  )
  const milestones = camelizeRows(
    db.prepare(
      `SELECT ms.id, ms.name, ms.plan_date, p.name AS project_name FROM milestones ms JOIN projects p ON p.id = ms.project_id
       WHERE p.status = 'active' AND ms.status = 'planned' AND ms.plan_date >= ? AND ms.plan_date <= ? ${scope}
       ORDER BY ms.plan_date`
    ).all(...args)
  )
  const sections = [`本周（${monday} ~ ${sunday}）到期：`]
  sections.push(tasks.length
    ? tasks.map((t) => `- ${t.projectName} #${t.id} ${t.title}（截止 ${t.planEndDate}，${t.owner || '未指派'}）`).join('\n')
    : '（本周无到期任务）')
  if (milestones.length) {
    sections.push(`本周里程碑：\n${milestones.map((m) => `- ${m.projectName}「${m.name}」（${m.planDate}）`).join('\n')}`)
  }
  return { weekStart: monday, weekEnd: sunday, tasks, milestones, text: sections.join('\n') }
}

/** /risk：全局风险板——逾期任务 / 沉默项目 / 未指派计数 / 关键人过载（空项明确标注）。 */
export function riskBoard(db, { now = Date.now() } = {}) {
  const todayDay = today(now)
  const th = getSetting(db, 'thresholds')
  const overdue = camelizeRows(
    db.prepare(
      `SELECT t.id, t.title, t.plan_end_date, p.name AS project_name, m.name AS owner FROM tasks t
       JOIN projects p ON p.id = t.project_id LEFT JOIN members m ON m.id = t.responsible_member_id
       WHERE p.status = 'active' AND t.status != 'done' AND t.deleted_at IS NULL
         AND t.plan_end_date IS NOT NULL AND t.plan_end_date < ?
       ORDER BY t.plan_end_date LIMIT 10`
    ).all(todayDay)
  )
  const overdueTotal = db.prepare(
    `SELECT COUNT(*) AS n FROM tasks t JOIN projects p ON p.id = t.project_id
     WHERE p.status = 'active' AND t.status != 'done' AND t.deleted_at IS NULL AND t.plan_end_date IS NOT NULL AND t.plan_end_date < ?`
  ).get(todayDay).n
  // 沉默项目（S48 同口径：最近已生效事件（无则立项时刻）早于 silentDays 天前且窗口内无任务变动）
  const silentCutoff = now - th.silentDays * DAY_MS
  const silent = camelizeRows(
    db.prepare(
      `SELECT p.id, p.name, COALESCE(
         (SELECT MAX(e.business_time) FROM project_events e WHERE e.project_id = p.id AND e.status = 'effective'),
         p.created_at) AS anchor,
         (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.deleted_at IS NULL AND t.updated_at >= ?) AS task_changes
       FROM projects p WHERE p.status = 'active'`
    ).all(silentCutoff)
  )
    .filter((p) => p.anchor < silentCutoff && p.taskChanges === 0)
    .map((p) => ({ id: p.id, name: p.name, silentDays: Math.floor((now - p.anchor) / DAY_MS) }))
  const unassigned = db.prepare(
    `SELECT COUNT(*) AS n FROM tasks t JOIN projects p ON p.id = t.project_id
     WHERE p.status = 'active' AND t.status != 'done' AND t.deleted_at IS NULL AND t.responsible_member_id IS NULL`
  ).get().n
  const overloaded = queryMetric(db, 'keyperson_load', { groupBy: 'member' }).rows.filter((r) => r.overloaded)

  const sections = [
    overdueTotal
      ? `逾期任务 ${overdueTotal} 项：\n${overdue.map((t) => `- ${t.projectName} #${t.id} ${t.title}（${t.owner || '未指派'}，超 ${dayDiff(t.planEndDate, todayDay)} 天）`).join('\n')}${overdueTotal > overdue.length ? `\n（等 ${overdueTotal} 项）` : ''}`
      : '逾期任务：无',
    silent.length ? `沉默项目 ${silent.length} 个：\n${silent.map((p) => `- ${p.name}（${p.silentDays} 天无动静）`).join('\n')}` : '沉默项目：无',
    `未指派任务 ${unassigned} 项`,
    overloaded.length ? `关键人过载：${overloaded.map((r) => `${r.member}（并行 ${r.parallelProjects}/${r.maxParallelProjects}）`).join('、')}` : '关键人过载：无',
  ]
  return { overdue, overdueTotal, silent, unassigned, overloaded, text: `⚠️ 项目风险板\n\n${sections.join('\n\n')}` }
}
