// 大脑·预警（S7，v0.6）：关键人逾期未完任务 → 推老板+本人；关键人过载 → 老板视图标红并推送。

import { camelizeRows } from '../db/index.mjs'
import { overdueTasksOf } from '../engine/tasks.js'
import { queryMetric } from '../engine/metrics.js'
import { notifyMember, notifyAdmins } from './push.js'

export function evaluateAlerts(db) {
  const alerts = []

  // S7-1（v0.6 口径）：关键人名下逾期未完任务 ≥1
  const keypersons = camelizeRows(db.prepare(`SELECT * FROM members WHERE status = 'active'`).all())
  for (const m of keypersons) {
    const ods = overdueTasksOf(db, m.id)
    if (!ods.length) continue
    const lines = ods.map((d) => `- ${d.projectName}「${d.title}」截止 ${d.planEndDate}，已逾期`)
    const body = `你有 ${ods.length} 项逾期未完任务：\n${lines.join('\n')}`
    notifyMember(db, m, { pushType: 'alert', title: `逾期任务预警：${m.name}`, body })
    notifyAdmins(db, { pushType: 'alert', title: `逾期任务预警：${m.name}（${ods.length} 项）`, body })
    alerts.push({ type: 'overdue_tasks', memberId: m.id, count: ods.length, projects: [...new Set(ods.map((d) => d.project_id || d.projectId))] })
  }

  // S7-2：关键人并行项目超上限（老板视图标红 + 推送）
  const load = queryMetric(db, 'keyperson_load', { groupBy: 'member' })
  for (const row of load.rows) {
    if (!row.overloaded) continue
    const body = `${row.member} 并行参与 ${row.parallelProjects} 个进行中项目（上限 ${row.maxParallelProjects}），未完任务 ${row.openTasks} 项。`
    notifyAdmins(db, { pushType: 'alert', title: `负载预警：${row.member}`, body })
    alerts.push({ type: 'overloaded', member: row.member, parallelProjects: row.parallelProjects, max: row.maxParallelProjects })
  }
  return { alerts }
}
