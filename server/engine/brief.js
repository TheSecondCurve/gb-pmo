// 项目 Brief 组装层（S27，v0.26）：单个项目的一次性全量摘要——概况/任务盘子/进行中/近期进展/下一步/风险。
// 确定性数据组装的唯一真相源（北京时区口径），会话面 LLM 只叙述、不自行拼口径（与 metrics 端点同哲学）。
// 列表截断上限与时间窗为代码常量（成本护栏非配置项，与 S20-13 字数预算同定位）。

import { camelizeRows } from '../db/index.mjs'
import { today, bjDayStartMs, dayDiff, DAY_MS } from '../db/time.js'
import { label } from './enums.js'

export const BRIEF_LIMITS = { doing: 10, progress: 8, riskEvents: 5, overdue: 5 }
export const BRIEF_WINDOWS = { progressDays: 14, riskDays: 30 }

/**
 * @param {number} projectId
 * @param {object} opts { now(固定时刻断言用), progressDays, riskDays }
 * @returns 结构化摘要（camelCase + 中文标签，供 LLM 叙述与测试断言）
 */
export function projectBrief(db, projectId, { now = Date.now(), progressDays = BRIEF_WINDOWS.progressDays, riskDays = BRIEF_WINDOWS.riskDays } = {}) {
  const p = db.prepare(
    `SELECT p.id, p.name, p.status, p.priority, p.client_name, p.plan_start_date, p.plan_end_date,
            p.actual_start_date, p.actual_end_date, p.closeout_summary, p.created_at, m.name AS lead
     FROM projects p LEFT JOIN members m ON m.id = p.lead_member_id WHERE p.id = ?`
  ).get(Number(projectId))
  if (!p) throw Object.assign(new Error(`项目不存在: ${projectId}`), { statusCode: 404 })

  const todayStr = today(now)

  // 任务盘子（逾期口径与 overdue_tasks 指标同源：plan_end_date < 今日 且 未完成）
  // SUM 在无行时返回 NULL——空项目归零（COALESCE），否则 LLM 会拿到 "todo: null" 叙述
  const c = db.prepare(
    `SELECT COUNT(*) AS total,
       COALESCE(SUM(CASE WHEN status = 'todo' THEN 1 ELSE 0 END), 0) AS todo,
       COALESCE(SUM(CASE WHEN status = 'doing' THEN 1 ELSE 0 END), 0) AS doing,
       COALESCE(SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END), 0) AS done,
       COALESCE(SUM(CASE WHEN status != 'done' AND plan_end_date IS NOT NULL AND plan_end_date < BJ_TODAY(?) THEN 1 ELSE 0 END), 0) AS overdue
     FROM tasks WHERE project_id = ? AND deleted_at IS NULL`
  ).get(now, p.id)
  const tasks = {
    total: c.total, todo: c.todo, doing: c.doing, done: c.done, overdue: c.overdue,
    completionRate: c.total ? Math.round((1e4 * c.done) / c.total) / 1e4 : 0,
  }

  // 进行中：按计划结束日升序（NULL 沉底），截断附总数
  const doing = camelizeRows(db.prepare(
    `SELECT t.id, t.title, t.plan_start_date AS plan_start_date, t.plan_end_date AS plan_end_date, m.name AS responsible
     FROM tasks t LEFT JOIN members m ON m.id = t.responsible_member_id
     WHERE t.project_id = ? AND t.status = 'doing' AND t.deleted_at IS NULL
     ORDER BY t.plan_end_date IS NULL, t.plan_end_date LIMIT ?`
  ).all(p.id, BRIEF_LIMITS.doing)).map((r) => ({
    id: r.id, title: r.title, responsible: r.responsible, planStartDate: r.planStartDate, planEndDate: r.planEndDate,
  }))

  // 下一步：未来计划开始日（缺省用结束日）最近的 todo；全逾期时回退为最早未开始；附最近 planned 里程碑
  const nextTask = camelizeRows(db.prepare(
    `SELECT t.id, t.title, t.plan_start_date AS plan_start_date, t.plan_end_date AS plan_end_date, m.name AS responsible
     FROM tasks t LEFT JOIN members m ON m.id = t.responsible_member_id
     WHERE t.project_id = ? AND t.status = 'todo' AND t.deleted_at IS NULL AND COALESCE(t.plan_start_date, t.plan_end_date) IS NOT NULL
     ORDER BY (COALESCE(t.plan_start_date, t.plan_end_date) < BJ_TODAY(?)), COALESCE(t.plan_start_date, t.plan_end_date)
     LIMIT 1`
  ).all(p.id, now)).map((r) => ({
    id: r.id, title: r.title, responsible: r.responsible, planStartDate: r.planStartDate, planEndDate: r.planEndDate,
  }))[0] ?? null
  const nextMilestone = db.prepare(
    `SELECT name, plan_date FROM milestones
     WHERE project_id = ? AND status = 'planned' AND plan_date IS NOT NULL AND plan_date >= BJ_TODAY(?)
     ORDER BY plan_date LIMIT 1`
  ).get(p.id, now) ?? null

  // 近期进展：近 N 天（北京日窗）已生效 progress 事件，倒序截断附窗口内总数
  const progressCutoff = bjDayStartMs(now) - (progressDays - 1) * DAY_MS
  const recentProgress = db.prepare(
    `SELECT e.business_time, e.summary, COALESCE(e.speaker_label, '—') AS speaker FROM project_events e
     WHERE e.project_id = ? AND e.status = 'effective' AND e.event_type = 'progress' AND e.business_time >= ?
     ORDER BY e.business_time DESC LIMIT ?`
  ).all(p.id, progressCutoff, BRIEF_LIMITS.progress)
    .map((r) => ({ date: today(r.business_time), summary: r.summary, speaker: r.speaker }))
  const recentProgressTotal = db.prepare(
    `SELECT COUNT(*) AS n FROM project_events e
     WHERE e.project_id = ? AND e.status = 'effective' AND e.event_type = 'progress' AND e.business_time >= ?`
  ).get(p.id, progressCutoff).n

  // 风险：逾期任务清单（超期天数 S21 口径，正数=已超天数）+ 近 N 天已生效 risk/blocker 事件
  const overdueTasks = db.prepare(
    `SELECT t.id, t.title, t.plan_end_date AS plan_end_date, m.name AS responsible FROM tasks t
     LEFT JOIN members m ON m.id = t.responsible_member_id
     WHERE t.project_id = ? AND t.status != 'done' AND t.deleted_at IS NULL AND t.plan_end_date IS NOT NULL AND t.plan_end_date < BJ_TODAY(?)
     ORDER BY t.plan_end_date LIMIT ?`
  ).all(p.id, now, BRIEF_LIMITS.overdue)
    .map((r) => ({ id: r.id, title: r.title, responsible: r.responsible, planEndDate: r.plan_end_date, daysOverdue: dayDiff(r.plan_end_date, todayStr) }))
  const riskCutoff = bjDayStartMs(now) - (riskDays - 1) * DAY_MS
  const riskEvents = db.prepare(
    `SELECT e.event_type, e.business_time, e.summary, COALESCE(e.speaker_label, '—') AS speaker FROM project_events e
     WHERE e.project_id = ? AND e.status = 'effective' AND e.event_type IN ('risk','blocker') AND e.business_time >= ?
     ORDER BY e.business_time DESC LIMIT ?`
  ).all(p.id, riskCutoff, BRIEF_LIMITS.riskEvents)
    .map((r) => ({ type: r.event_type, date: today(r.business_time), summary: r.summary, speaker: r.speaker }))
  const riskEventsTotal = db.prepare(
    `SELECT COUNT(*) AS n FROM project_events e
     WHERE e.project_id = ? AND e.status = 'effective' AND e.event_type IN ('risk','blocker') AND e.business_time >= ?`
  ).get(p.id, riskCutoff).n

  // 活跃度：最后已生效事件（缺省立项时刻）与沉默天数（与 project_health 指标同口径）
  const lastEventAt = db.prepare(
    `SELECT COALESCE(MAX(e.business_time), ?) AS t FROM project_events e WHERE e.project_id = ? AND e.status = 'effective'`
  ).get(p.created_at, p.id).t

  return {
    project: {
      id: p.id, name: p.name, status: p.status, statusLabel: label('projectStatus', p.status),
      priority: p.priority, priorityLabel: label('priority', p.priority),
      lead: p.lead, clientName: p.client_name,
      planStartDate: p.plan_start_date, planEndDate: p.plan_end_date,
      remainingDays: p.plan_end_date ? dayDiff(todayStr, p.plan_end_date) : null, // 负=超期天数（S21）
      actualStartDate: p.actual_start_date, actualEndDate: p.actual_end_date, closeoutSummary: p.closeout_summary,
    },
    tasks,
    doing,
    next: {
      task: nextTask,
      milestone: nextMilestone ? { name: nextMilestone.name, planDate: nextMilestone.plan_date } : null,
    },
    recentProgress,
    recentProgressTotal,
    risks: { overdueTasks, events: riskEvents, eventsTotal: riskEventsTotal },
    activity: { lastEventAt, silentDays: Math.max(0, Math.floor((now - lastEventAt) / DAY_MS)) },
    asOf: todayStr,
  }
}
