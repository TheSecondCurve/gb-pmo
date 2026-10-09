// 大脑·日报（S6）：按角色分视角，全员在职成员接收；无更新项目标「今日无更新」。
// 时点由 scheduler.reportCron 驱动（v0.7，取代 dailyReportHour）；当日已发不重复（S18-4，force 手动重发绕过）。

import { camelizeRows, camelizeRow } from '../db/index.mjs'
import { today, bjDayStartMs } from '../db/time.js'
import { getSetting } from '../engine/settings.js'
import { expireStaleSuggestions } from '../engine/events.js'
import { queryMetric } from '../engine/metrics.js'
import { taskRefMap, formatTaskRefs } from '../engine/tasks.js'
import { notifyMember } from './push.js'

export async function dailyReport(db, { force = false } = {}) {
  const now = new Date()
  const dayStart = bjDayStartMs(now) // 「当日」按北京日（S19）
  if (!force) {
    const sent = db
      .prepare(`SELECT COUNT(*) AS n FROM pushes WHERE push_type = 'daily_report' AND created_at >= ?`)
      .get(dayStart).n
    if (sent > 0) return { skipped: true, reason: '今日已推送过日报，不重复发送' }
  }
  expireStaleSuggestions(db, getSetting(db, 'thresholds').suggestTimeoutHours)

  const members = camelizeRows(db.prepare(`SELECT * FROM members WHERE status = 'active'`).all())
  const projects = camelizeRows(
    db.prepare(
      `SELECT p.*, m.name AS lead_name FROM projects p LEFT JOIN members m ON m.id = p.lead_member_id
       WHERE p.status = 'active' ORDER BY CASE p.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END`
    ).all()
  )
  const todayEvents = camelizeRows(
    db.prepare('SELECT project_id, summary FROM project_events WHERE business_time >= ? AND status = ?').all(dayStart, 'effective')
  )
  const eventsOf = (pid) => todayEvents.filter((e) => e.projectId === pid)

  const reports = []
  for (const m of members) {
    const isAdmin = m.role === 'admin'
    const sections = []

    // 责任人视角：名下任务 + 待确认建议 + 明日到期
    const myTasks = camelizeRows(
      db.prepare(
        `SELECT t.id, t.title, t.plan_end_date, p.name AS project_name FROM tasks t JOIN projects p ON p.id = t.project_id
         WHERE t.responsible_member_id = ? AND t.status IN ('todo','doing') AND t.deleted_at IS NULL`
      ).all(m.id)
    )
    const tomorrow = today(now.getTime() + 86400000)
    const dueTomorrow = myTasks.filter((t) => t.planEndDate === tomorrow)
    const pending = camelizeRows(
      db.prepare(
        `SELECT e.summary FROM project_events e LEFT JOIN tasks t ON t.id = e.target_task_id LEFT JOIN projects p ON p.id = e.project_id
         WHERE e.status = 'pending' AND (t.id IS NULL OR t.deleted_at IS NULL) AND (t.responsible_member_id = ? OR p.lead_member_id = ?)`
      ).all(m.id, m.id)
    )
    sections.push(`【我的任务】未完 ${myTasks.length} 项${dueTomorrow.length ? `，明日到期 ${dueTomorrow.length} 项（${dueTomorrow.map((t) => t.title).join('、')}）` : ''}${pending.length ? `\n【待确认建议】${pending.length} 条等你处理` : ''}`)

    // S23：名下任务挂了参考资料的，列出标题+链接（执行人拿到完整信息；无资料不加空段落）
    const refMap = taskRefMap(db, myTasks.map((t) => t.id))
    const withRefs = myTasks.filter((t) => refMap.get(t.id)?.length)
    if (withRefs.length) {
      sections.push(`【参考资料】\n${withRefs.map((t) => `- ${t.title}：${formatTaskRefs(refMap.get(t.id))}`).join('\n')}`)
    }

    // 牵头人视角：所辖项目进展（S6-2：无更新标注而非省略）
    const myProjects = projects.filter((p) => p.leadMemberId === m.id)
    if (myProjects.length) {
      const lines = myProjects.map((p) => {
        const evts = eventsOf(p.id)
        return `- ${p.name}：${evts.length ? `${evts.length} 条更新（${evts.slice(0, 2).map((e) => e.summary).join('；')}）` : '今日无更新'}`
      })
      sections.push(`【所辖项目】\n${lines.join('\n')}`)
    }

    // 老板视角（管理员）：全局项目动态（全部在跑项目都出现）+ 依赖预警
    if (isAdmin) {
      const lines = projects.map((p) => {
        const evts = eventsOf(p.id)
        return `- [${p.priority}] ${p.name}：${evts.length ? `${evts.length} 条更新` : '今日无更新'}`
      })
      const load = queryMetric(db, 'keyperson_load', { groupBy: 'member' })
      const overloaded = load.rows.filter((r) => r.overloaded)
      sections.push(
        `【全局】\n${lines.join('\n')}${overloaded.length ? `\n【负载预警】${overloaded.map((r) => `${r.member}(${r.parallelProjects} 项目)`).join('、')}` : ''}`
      )
    }

    const title = `项目大脑日报 ${today(now)}`
    notifyMember(db, m, { pushType: 'daily_report', title, body: sections.join('\n\n') })
    reports.push({ memberId: m.id, sections: sections.length })
  }
  return { reports: reports.length, at: now.toISOString() }
}

export { camelizeRow }
