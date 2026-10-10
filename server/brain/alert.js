// 大脑·预警（S7，v0.6）：关键人逾期未完任务 → 推老板+本人；关键人过载 → 老板视图标红并推送。
// v0.51（S46）：推送经 opts.send 注入的投递层真实下发（缺省走飞书配置；失败落行不阻塞）。
// v0.53（S48-4，K31）：沉默项目预警——连续 silentDays 天无已生效事件且无任务变动的在跑项目
// 推牵头人+管理员；同项目同窗口按 pushes 既有行节流（预警周期 15 分钟不刷屏）。

import { camelizeRows, camelizeRow } from '../db/index.mjs'
import { overdueTasksOf, taskRefMap, formatTaskRefs } from '../engine/tasks.js'
import { queryMetric } from '../engine/metrics.js'
import { getSetting } from '../engine/settings.js'
import { notifyMember, notifyAdmins } from './push.js'

const DAY = 86400000

export async function evaluateAlerts(db, { send } = {}) {
  const alerts = []
  const nowMs = Date.now()

  // S7-1（v0.6 口径）：关键人名下逾期未完任务 ≥1
  const keypersons = camelizeRows(db.prepare(`SELECT * FROM members WHERE status = 'active'`).all())
  for (const m of keypersons) {
    const ods = overdueTasksOf(db, m.id)
    if (!ods.length) continue
    // S23：逾期任务行附带参考资料（告诉他逾期任务照哪份 SOP 做）
    const refMap = taskRefMap(db, ods.map((d) => d.id))
    const lines = ods.map((d) => {
      const refs = formatTaskRefs(refMap.get(d.id))
      return `- ${d.projectName}「${d.title}」截止 ${d.planEndDate}，已逾期${refs ? `\n  参考：${refs}` : ''}`
    })
    const body = `你有 ${ods.length} 项逾期未完任务：\n${lines.join('\n')}`
    await notifyMember(db, m, { pushType: 'alert', title: `逾期任务预警：${m.name}`, body }, { send })
    await notifyAdmins(db, { pushType: 'alert', title: `逾期任务预警：${m.name}（${ods.length} 项）`, body }, { send })
    alerts.push({ type: 'overdue_tasks', memberId: m.id, count: ods.length, projects: [...new Set(ods.map((d) => d.project_id || d.projectId))] })
  }

  // S7-2：关键人并行项目超上限（老板视图标红 + 推送）
  const load = queryMetric(db, 'keyperson_load', { groupBy: 'member' })
  for (const row of load.rows) {
    if (!row.overloaded) continue
    const body = `${row.member} 并行参与 ${row.parallelProjects} 个进行中项目（上限 ${row.maxParallelProjects}），未完任务 ${row.openTasks} 项。`
    await notifyAdmins(db, { pushType: 'alert', title: `负载预警：${row.member}`, body }, { send })
    alerts.push({ type: 'overloaded', member: row.member, parallelProjects: row.parallelProjects, max: row.maxParallelProjects })
  }

  // S48-4：沉默项目预警（纯确定性，零 LLM 成本）
  const silentMs = getSetting(db, 'thresholds').silentDays * DAY
  const candidates = camelizeRows(
    db.prepare(
      `SELECT p.id, p.name, p.lead_member_id, p.created_at,
              (SELECT MAX(e.business_time) FROM project_events e WHERE e.project_id = p.id AND e.status = 'effective') AS last_event_at,
              (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.deleted_at IS NULL AND t.updated_at >= ?) AS task_changes
       FROM projects p WHERE p.status = 'active'`
    ).all(nowMs - silentMs)
  )
  for (const p of candidates) {
    if (p.taskChanges > 0) continue // 窗口内有任务变动 = 不沉默
    const anchor = p.lastEventAt ?? p.createdAt // 无事件时以立项时刻起算沉默
    const silentFor = nowMs - anchor
    if (silentFor < silentMs) continue
    // 节流：同项目同标题推送在沉默窗口内已发过即跳过
    const dup = db
      .prepare(`SELECT 1 FROM pushes WHERE push_type = 'alert' AND related_project_id = ? AND title LIKE '沉默项目预警%' AND created_at >= ?`)
      .get(p.id, nowMs - silentMs)
    if (dup) continue
    const days = Math.floor(silentFor / DAY)
    const lead = db.prepare('SELECT * FROM members WHERE id = ?').get(p.leadMemberId)
    const payload = {
      pushType: 'alert', projectId: p.id,
      title: `沉默项目预警：${p.name}`,
      body: `项目「${p.name}」已连续 ${days} 天无已生效事件且无任务变动。请关注：是真停滞还是讨论没进群？`,
    }
    if (lead) await notifyMember(db, camelizeRow(lead), payload, { send })
    await notifyAdmins(db, payload, { send })
    alerts.push({ type: 'silent_project', projectId: p.id, days })
  }
  return { alerts }
}
