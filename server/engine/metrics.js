// 指标定义层：口径唯一真相源（analytics-design.md）。
// dashboard 页面与 Agent metrics 端点都从这里取数，禁止在别处手写指标 SQL。

import { camelizeRows } from '../db/index.mjs'
import { today, bjWeekStartMs } from '../db/time.js'
import { getSetting } from './settings.js'

const OPEN_PROJECT = `p.status = 'active'` // S29 三态：在跑=进行中
// S36：已删任务退出指标口径；S57（v0.62）：追踪口径只认工作类——纯提醒有独立送达通道，不占分母
const OPEN_TASK = `t.status IN ('todo','doing') AND t.deleted_at IS NULL AND t.kind = 'work'`
const DAY = 86400000

function daysSince(ts) {
  return Math.floor((Date.now() - ts) / DAY)
}

export const METRICS = [
  {
    id: 'running_projects',
    name: '在跑项目数与状态分布',
    domain: '业务',
    definition: '状态=进行中的项目数；不含已结项/已取消（S29 三态口径）',
    dims: ['status', 'priority', 'lead'],
    timeBasis: '按日快照（实时计算）',
    freq: '每周',
  },
  {
    id: 'overdue_tasks',
    name: '逾期任务数 / 逾期率',
    domain: '经营有效性',
    definition: '计划结束日<今日且状态≠完成的任务；率=逾期数÷全部未完任务',
    dims: ['project', 'member', 'priority'],
    timeBasis: '按日',
    freq: '每日',
  },
  {
    id: 'unassigned_tasks',
    name: '未指派任务数',
    domain: '业务',
    definition: '已设计划开始日但责任人留空的任务（默认路径责任人=牵头人，出现即兜底告警）',
    dims: ['project', 'lead'],
    timeBasis: '按日',
    freq: '每周',
  },
  {
    id: 'project_health',
    name: '优先级 TOP 项目健康度',
    domain: '经营有效性',
    definition: '按优先级档位取前 N 个在跑项目：沉默天数+逾期任务数组合分级（红/黄/绿，阈值可配）',
    dims: ['project'],
    timeBasis: '按日',
    freq: '每日',
  },
  {
    id: 'silent_projects',
    name: '沉默项目数',
    domain: '经营有效性',
    definition: '连续 N 天（默认 7）无任何已生效事件的在跑项目',
    dims: ['priority', 'lead'],
    timeBasis: '按日',
    freq: '每周',
  },
  {
    id: 'keyperson_load',
    name: '关键人负载',
    domain: '经营有效性',
    definition: '每人：进行中项目参与数 + 未完任务数 + 被依赖未满足项数；超过并行上限标红',
    dims: ['member', 'team'],
    timeBasis: '按日',
    freq: '每周',
  },
  {
    id: 'weekly_project_flow',
    name: '本周新增 / 结项项目数',
    domain: '业务',
    definition: '立项日/结项日落在本自然周',
    dims: ['flow'],
    timeBasis: '按周',
    freq: '每周',
  },
  {
    id: 'suggestion_acceptance',
    name: '建议采纳率',
    domain: '经营有效性',
    definition: '滚动 7 天内已生效的抽取/建议类事件数÷其生成总数（大脑质量，S3 告警依据）',
    dims: ['project', 'platform'],
    timeBasis: '滚动 7 天',
    freq: '每周（管理员）',
  },
]

export function listMetrics() {
  return METRICS.map(({ id, name, domain, definition, dims, timeBasis, freq }) => ({
    id, name, domain, definition, dims, timeBasis, freq,
  }))
}

export function getMetric(id) {
  const m = METRICS.find((x) => x.id === id)
  if (!m) throw Object.assign(new Error(`未知指标: ${id}`), { statusCode: 404 })
  return m
}

/** 统一取数入口：dashboard 与 /api/v1/agent/metrics/query 共用（S5-3 同源验收）。 */
export function queryMetric(db, id, params = {}) {
  const m = getMetric(id)
  const fn = IMPLEMENTATIONS[id]
  return { metric: { id: m.id, name: m.name, definition: m.definition }, ...fn(db, params) }
}

// —— 实现 ——

const IMPLEMENTATIONS = {
  running_projects(db, { groupBy = 'status' } = {}) {
    const dims = {
      status: { col: 'p.status', alias: 'status' },
      priority: { col: 'p.priority', alias: 'priority' },
      lead: { col: 'm.name', alias: 'lead', join: true },
    }[groupBy]
    if (!dims) throw badDim('running_projects', groupBy)
    const rows = db
      .prepare(
        `SELECT ${dims.col} AS ${dims.alias}, COUNT(*) AS count FROM projects p
         ${dims.join ? 'LEFT JOIN members m ON m.id = p.lead_member_id' : ''}
         WHERE ${OPEN_PROJECT} GROUP BY ${dims.col} ORDER BY count DESC`
      )
      .all()
    return { columns: [dims.alias, 'count'], rows }
  },

  overdue_tasks(db, { groupBy = 'project' } = {}) {
    const dims = {
      project: { col: 'p.name', alias: 'project', fk: 't.project_id = p.id' },
      member: { col: 'm.name', alias: 'member', fk: 't.responsible_member_id = m.id' },
      priority: { col: 'p.priority', alias: 'priority', fk: 't.project_id = p.id' },
    }[groupBy]
    if (!dims) throw badDim('overdue_tasks', groupBy)
    const rows = db
      .prepare(
        `SELECT ${dims.col} AS ${dims.alias},
           SUM(CASE WHEN t.plan_end_date IS NOT NULL AND t.plan_end_date < BJ_TODAY() THEN 1 ELSE 0 END) AS overdue,
           COUNT(*) AS open_tasks,
           ROUND(1.0 * SUM(CASE WHEN t.plan_end_date IS NOT NULL AND t.plan_end_date < BJ_TODAY() THEN 1 ELSE 0 END) / COUNT(*), 4) AS overdue_rate
         FROM tasks t LEFT JOIN projects p ON t.project_id = p.id LEFT JOIN members m ON m.id = t.responsible_member_id
         WHERE ${OPEN_TASK} GROUP BY ${dims.col}`
      )
      .all()
    return { columns: [dims.alias, 'overdue', 'openTasks', 'overdueRate'], rows: camelizeRows(rows) }
  },

  unassigned_tasks(db, { groupBy = 'project' } = {}) {
    const dims = {
      project: { col: 'p.name', alias: 'project' },
      lead: { col: 'm.name', alias: 'lead', join: 'LEFT JOIN members m ON m.id = p.lead_member_id' },
    }[groupBy]
    if (!dims) throw badDim('unassigned_tasks', groupBy)
    const rows = db
      .prepare(
        `SELECT ${dims.col} AS ${dims.alias}, COUNT(*) AS count FROM tasks t
         JOIN projects p ON t.project_id = p.id ${dims.join || ''}
         WHERE t.responsible_member_id IS NULL AND t.plan_start_date IS NOT NULL AND ${OPEN_TASK.replace(/t\./g, 't.')}
         GROUP BY ${dims.col}`
      )
      .all()
    return { columns: [dims.alias, 'count'], rows }
  },

  project_health(db, { topN = 10 } = {}) {
    const th = getSetting(db, 'thresholds')
    const rows = db
      .prepare(
        `SELECT p.id, p.name, p.priority, m.name AS lead,
           (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND ${OPEN_TASK} AND t.plan_end_date IS NOT NULL AND t.plan_end_date < BJ_TODAY()) AS overdue_tasks,
           (SELECT COALESCE(MAX(e.business_time), p.created_at) FROM project_events e WHERE e.project_id = p.id AND e.status = 'effective') AS last_effective_at
         FROM projects p LEFT JOIN members m ON m.id = p.lead_member_id
         WHERE ${OPEN_PROJECT}
         ORDER BY CASE p.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, p.updated_at DESC
         LIMIT ?`
      )
      .all(topN)
    const out = rows.map((r) => {
      const silentDays = daysSince(r.last_effective_at)
      let health = 'green'
      if (silentDays >= th.healthRed.silentDays || r.overdue_tasks >= th.healthRed.overdue) health = 'red'
      else if (silentDays >= th.healthYellow.silentDays || r.overdue_tasks >= th.healthYellow.overdue) health = 'yellow'
      return { id: r.id, project: r.name, priority: r.priority, lead: r.lead, overdueTasks: r.overdue_tasks, silentDays, health }
    })
    return { columns: ['id', 'project', 'priority', 'lead', 'overdueTasks', 'silentDays', 'health'], rows: out }
  },

  silent_projects(db, { groupBy = 'priority' } = {}) {
    const th = getSetting(db, 'thresholds')
    const cutoff = Date.now() - th.silentDays * DAY
    const dims = { priority: 'p.priority', lead: 'm.name' }[groupBy]
    if (!dims) throw badDim('silent_projects', groupBy)
    const rows = db
      .prepare(
        `SELECT ${dims} AS ${groupBy}, COUNT(*) AS count FROM projects p LEFT JOIN members m ON m.id = p.lead_member_id
         WHERE ${OPEN_PROJECT} AND COALESCE((SELECT MAX(e.business_time) FROM project_events e WHERE e.project_id = p.id AND e.status = 'effective'), p.created_at) < ?
         GROUP BY ${dims}`
      )
      .all(cutoff)
    return { columns: [groupBy, 'count'], rows, threshold: th.silentDays }
  },

  keyperson_load(db, { groupBy = 'member' } = {}) {
    const dims = { member: 'm.name', team: 'COALESCE(m.team, "未分组")' }[groupBy]
    if (!dims) throw badDim('keyperson_load', groupBy)
    const rows = db
      .prepare(
        `SELECT ${dims} AS ${groupBy}, m.is_key_person, m.max_parallel_projects,
           (SELECT COUNT(DISTINCT p2.id) FROM projects p2 WHERE p2.status = 'active' AND (p2.lead_member_id = m.id
              OR p2.id IN (SELECT project_id FROM tasks WHERE responsible_member_id = m.id AND status IN ('todo','doing','blocked') AND deleted_at IS NULL AND kind = 'work'))) AS parallel_projects,
           (SELECT COUNT(*) FROM tasks t2 WHERE t2.responsible_member_id = m.id AND t2.status IN ('todo','doing') AND t2.deleted_at IS NULL AND t2.kind = 'work') AS open_tasks
         FROM members m WHERE m.status = 'active' GROUP BY ${dims}, m.id ORDER BY parallel_projects DESC`
      )
      .all()
    const out = rows.map((r) => ({
      ...r,
      is_key_person: Boolean(r.is_key_person),
      overloaded: r.parallel_projects > r.max_parallel_projects,
    }))
    return { columns: [groupBy, 'isKeyPerson', 'parallelProjects', 'openTasks', 'overloaded'], rows: camelizeRows(out) }
  },

  weekly_project_flow(db) {
    const mondayMs = bjWeekStartMs() // 本自然周按北京时区（S19）
    const started = db.prepare('SELECT COUNT(*) AS n FROM projects WHERE created_at >= ?').get(mondayMs).n
    const closed = db.prepare('SELECT COUNT(*) AS n FROM projects WHERE actual_end_date >= ?').get(today(mondayMs)).n
    return { columns: ['flow', 'count'], rows: [{ flow: 'started', count: started }, { flow: 'closed', count: closed }] }
  },

  suggestion_acceptance(db, { groupBy = 'project', days = 7 } = {}) {
    const cutoff = Date.now() - days * DAY
    const dims = { project: 'p.name', platform: 'e.source_platform' }[groupBy]
    if (!dims) throw badDim('suggestion_acceptance', groupBy)
    const rows = db
      .prepare(
        `SELECT ${dims} AS ${groupBy},
           COUNT(*) AS generated,
           SUM(CASE WHEN e.status = 'effective' THEN 1 ELSE 0 END) AS accepted,
           ROUND(1.0 * SUM(CASE WHEN e.status = 'effective' THEN 1 ELSE 0 END) / COUNT(*), 4) AS acceptance_rate
         FROM project_events e LEFT JOIN projects p ON p.id = e.project_id
         WHERE e.nature = 'suggestion' AND e.created_at >= ?
         GROUP BY ${dims}`
      )
      .all(cutoff)
    return { columns: [groupBy, 'generated', 'accepted', 'acceptanceRate'], rows: camelizeRows(rows) }
  },
}

function badDim(metric, dim) {
  return Object.assign(new Error(`指标 ${metric} 不支持维度 ${dim}`), { statusCode: 400 })
}

/** S3-5：采纳率低于阈值时给管理员的告警判定（供 brain/alert 使用与测试）。 */
export function acceptanceAlarm(db) {
  const th = getSetting(db, 'thresholds')
  const r = IMPLEMENTATIONS.suggestion_acceptance(db, { groupBy: 'project', days: 7 })
  const total = r.rows.reduce((s, x) => s + x.generated, 0)
  if (total === 0) return null
  const accepted = r.rows.reduce((s, x) => s + x.accepted, 0)
  const rate = accepted / total
  if (rate >= th.acceptanceAlarm) return null
  return { rate, threshold: th.acceptanceAlarm, generated: total, accepted }
}

