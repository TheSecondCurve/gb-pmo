// 今日晨报组装层（S28，v0.27）：按会话定域的当日项目盘面——专题群=本群项目，其余=全部在跑项目。
// 确定性数据组装的唯一真相源（北京时区：昨日零点起的事件窗、今日到期/逾期按北京日），LLM 只转述不拼口径。
// 上限为代码常量（成本护栏非配置项，与 S20-13 字数预算同定位）。

import { today, bjDayStartMs, dayDiff, DAY_MS } from '../db/time.js'
import { label } from './enums.js'

export const MORNING_LIMITS = { projects: 20, tasks: 5, events: 5 }
const OPEN_PROJECT = `status IN ('planning','active','paused')`
const WEEKDAY = '日一二三四五六'

/**
 * @param {object} opts { projectId(显式单项目；缺省=全部在跑项目), now(固定时刻断言用) }
 * @returns { asOf, weekday, projects: [块结构], more, text(整段晨报文本) }
 */
export function morningReport(db, { projectId, now = Date.now() } = {}) {
  const todayStr = today(now)
  const sinceMs = bjDayStartMs(now) - DAY_MS // 晨报窗口：昨日北京日零点起（昨天+今天）

  let rows
  if (projectId !== undefined && projectId !== null) {
    rows = db.prepare('SELECT * FROM projects WHERE id = ?').all(Number(projectId))
    if (!rows.length) throw Object.assign(new Error(`项目不存在: ${projectId}`), { statusCode: 404 })
  } else {
    rows = db.prepare(
      `SELECT * FROM projects WHERE ${OPEN_PROJECT}
       ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, plan_end_date IS NULL, plan_end_date`
    ).all()
  }

  const projects = rows.slice(0, MORNING_LIMITS.projects).map((p) => blockFor(db, p, { todayStr, sinceMs }))
  const more = Math.max(0, rows.length - projects.length)

  const weekday = WEEKDAY[new Date(`${todayStr}T00:00:00Z`).getUTCDay()]
  const header = `📈 项目大脑晨报 ${todayStr}（星期${weekday}）`
  const body = projects.length ? projects.map((b) => b.text).join('\n\n') : '当前没有在跑项目。'
  const text = projects.length && more > 0 ? `${header}\n\n${body}\n\n（及其余 ${more} 个在跑项目）` : `${header}\n\n${body}`
  return { asOf: todayStr, weekday, projects, more, text }
}

function blockFor(db, p, { todayStr, sinceMs }) {
  const dueToday = db.prepare(
    `SELECT t.title, m.name AS responsible FROM tasks t LEFT JOIN members m ON m.id = t.responsible_member_id
     WHERE t.project_id = ? AND t.status != 'done' AND t.plan_end_date = ? ORDER BY t.plan_end_date`
  ).all(p.id, todayStr)
  const overdueTasks = db.prepare(
    `SELECT t.title, m.name AS responsible, t.plan_end_date AS plan_end_date FROM tasks t
     LEFT JOIN members m ON m.id = t.responsible_member_id
     WHERE t.project_id = ? AND t.status != 'done' AND t.plan_end_date IS NOT NULL AND t.plan_end_date < ?
     ORDER BY t.plan_end_date LIMIT ?`
  ).all(p.id, todayStr, MORNING_LIMITS.tasks)
    .map((r) => ({ title: r.title, responsible: r.responsible, planEndDate: r.plan_end_date, daysOverdue: dayDiff(r.plan_end_date, todayStr) }))
  const overdueTotal = db.prepare(
    `SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND status != 'done' AND plan_end_date IS NOT NULL AND plan_end_date < ?`
  ).get(p.id, todayStr).n
  const counts = db.prepare(
    `SELECT SUM(CASE WHEN status = 'doing' THEN 1 ELSE 0 END) AS doing,
            SUM(CASE WHEN status != 'done' THEN 1 ELSE 0 END) AS open
     FROM tasks WHERE project_id = ?`
  ).get(p.id)
  const events = db.prepare(
    `SELECT e.event_type, e.business_time, e.summary, COALESCE(e.speaker_label, '—') AS speaker FROM project_events e
     WHERE e.project_id = ? AND e.status = 'effective' AND e.event_type IN ('progress','risk','blocker','decision') AND e.business_time >= ?
     ORDER BY e.business_time DESC LIMIT ?`
  ).all(p.id, sinceMs, MORNING_LIMITS.events)
    .map((r) => ({ type: r.event_type, typeLabel: label('eventType', r.event_type), date: today(r.business_time), summary: r.summary, speaker: r.speaker }))

  const lines = [`【${p.name}】${label('projectStatus', p.status)}${p.plan_end_date ? ` · 交付剩 ${dayDiff(todayStr, p.plan_end_date)} 天` : ''}`]
  if (dueToday.length) lines.push(`· 今日到期 ${dueToday.length}：${dueToday.map((t) => `${t.title}（${t.responsible || '未指派'}）`).join('、')}`)
  if (overdueTotal) {
    const top = overdueTasks.map((t) => `${t.title}（${t.responsible || '未指派'}，超 ${t.daysOverdue} 天）`).join('、')
    lines.push(`· 逾期 ${overdueTotal}：${top}${overdueTotal > overdueTasks.length ? ` 等 ${overdueTotal} 项` : ''}`)
  }
  lines.push(`· 进行中 ${counts.doing || 0} 项，未完共 ${counts.open || 0} 项`)
  lines.push(events.length
    ? `· 昨日以来：\n${events.map((e) => `  - ${e.speaker}：${e.summary}（${e.typeLabel}）`).join('\n')}`
    : '· 昨日以来无动态')

  return {
    id: p.id, name: p.name, status: p.status, statusLabel: label('projectStatus', p.status),
    planEndDate: p.plan_end_date, remainingDays: p.plan_end_date ? dayDiff(todayStr, p.plan_end_date) : null,
    dueToday, overdueTasks, overdueTotal, doingCount: counts.doing || 0, openCount: counts.open || 0,
    events, text: lines.join('\n'),
  }
}
