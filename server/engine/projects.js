import { camelizeRow, camelizeRows } from '../db/index.mjs'
import { assertValue } from './enums.js'
import { addEvent } from './events.js'
import { audit } from './auth.js'
import { resolveTemplateForCreate } from './projectTypes.js'

const OPEN_STATUSES = ['planning', 'active', 'paused']
const PRIORITY_ORDER = `CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END`

/** S1 立项：选项目类型→套用其绑定模板实例化（S1-5；兼容直给 templateCode），牵头人必填、任务默认责任人=牵头人（D3）。 */
export function createProject(db, input, by) {
  const { name, typeCode, templateCode, leadMemberId, priority = 'medium', clientName,
    planStartDate, planEndDate, milestones = [] } = input
  if (!name) throw Object.assign(new Error('项目名必填'), { statusCode: 400 })
  if (!leadMemberId) throw Object.assign(new Error('牵头人必填（S1-1）'), { statusCode: 400 })
  assertValue('priority', priority)
  const lead = db.prepare(`SELECT id FROM members WHERE id = ? AND status = 'active'`).get(leadMemberId)
  if (!lead) throw Object.assign(new Error('牵头人不存在或已离职'), { statusCode: 400 })
  const { type, template: tpl } = resolveTemplateForCreate(db, { typeCode, templateCode })

  const now = Date.now()
  const today = new Date().toISOString().slice(0, 10)
  const created = db.transaction(() => {
    const info = db.prepare(
      `INSERT INTO projects (name, template_code, project_type_id, status, priority, lead_member_id, client_name,
         plan_start_date, plan_end_date, actual_start_date, created_by, created_at, updated_at)
       VALUES (?, ?, ?, 'planning', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(name, tpl.code, type?.id ?? null, priority, leadMemberId, clientName || null,
      planStartDate || null, planEndDate || null, null, by ?? null, now, now)
    const projectId = Number(info.lastInsertRowid)

    const tasks = db.prepare('SELECT title FROM template_tasks WHERE template_id = ? ORDER BY sort_order').all(tpl.id)
    for (const t of tasks) {
      db.prepare(
        `INSERT INTO tasks (project_id, title, responsible_member_id, status, plan_start_date, source, created_at, updated_at)
         VALUES (?, ?, ?, 'todo', ?, 'template', ?, ?)`
      ).run(projectId, t.title, leadMemberId, planStartDate || today, now, now)
    }
    for (const m of milestones) {
      db.prepare('INSERT INTO milestones (project_id, name, plan_date, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(projectId, m.name, m.planDate || null, 'planned', now, now)
    }
    addEvent(db, {
      projectId, eventType: 'decision', nature: 'record', sourcePlatform: 'web', generatedBy: 'web',
      summary: `项目立项：${type ? `类型「${type.name}」· ` : ''}模板「${tpl.name}」，牵头人 #${leadMemberId}${planEndDate ? `，计划 ${planStartDate || ''}~${planEndDate}` : ''}`,
      speakerMemberId: by ?? null,
    })
    audit(db, { memberId: by, action: 'project.create', objectType: 'project', objectId: projectId, detail: { templateCode: tpl.code, typeCode: type?.code } })
    return projectId
  })
  const id = created()
  return getProjectDetail(db, id)
}

export function getProject(db, id) {
  return camelizeRow(db.prepare('SELECT * FROM projects WHERE id = ?').get(id))
}

export function getProjectDetail(db, id) {
  const p = db
    .prepare(
      `SELECT p.*, m.name AS lead_name, m2.name AS created_by_name, pt.name AS type_name
       FROM projects p
       LEFT JOIN members m ON m.id = p.lead_member_id
       LEFT JOIN members m2 ON m2.id = p.created_by
       LEFT JOIN project_types pt ON pt.id = p.project_type_id
       WHERE p.id = ?`
    )
    .get(id)
  if (!p) throw Object.assign(new Error('项目不存在'), { statusCode: 404 })
  const tasks = db
    .prepare(
      `SELECT t.*, m.name AS responsible_name FROM tasks t LEFT JOIN members m ON m.id = t.responsible_member_id
       WHERE t.project_id = ? ORDER BY t.id`
    )
    .all(id)
  const today = new Date().toISOString().slice(0, 10)
  const taskRows = tasks.map((t) => ({
    ...camelizeRow(t),
    isOverdue: Boolean(t.plan_end_date && t.plan_end_date < today && t.status !== 'done'),
  }))
  return {
    ...camelizeRow(p),
    tasks: taskRows,
    milestones: camelizeRows(db.prepare('SELECT * FROM milestones WHERE project_id = ? ORDER BY plan_date').all(id)),
    channels: camelizeRows(
      db.prepare('SELECT id, platform, group_key, name, channel_type FROM channels WHERE project_id = ?').all(id)
    ),
  }
}

/** S5-1 全局列表：按优先级档位排序，含健康度要素（逾期数 / 最近实质更新）。 */
export function listProjects(db, { statuses = OPEN_STATUSES } = {}) {
  const ph = statuses.map(() => '?').join(',')
  const rows = db
    .prepare(
      `SELECT p.*, m.name AS lead_name, pt.name AS type_name,
         (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status IN ('todo','doing','blocked')
            AND t.plan_end_date IS NOT NULL AND t.plan_end_date < date('now')) AS overdue_tasks,
         (SELECT MAX(e.business_time) FROM project_events e WHERE e.project_id = p.id AND e.status = 'effective') AS last_event_at
       FROM projects p LEFT JOIN members m ON m.id = p.lead_member_id
       LEFT JOIN project_types pt ON pt.id = p.project_type_id
       WHERE p.status IN (${ph})
       ORDER BY ${PRIORITY_ORDER}, p.updated_at DESC`
    )
    .all(...statuses)
  const today = new Date().toISOString().slice(0, 10)
  return rows.map((r) => {
    const row = camelizeRow(r)
    row.silentDays = row.lastEventAt ? Math.floor((Date.now() - row.lastEventAt) / 86400000) : null
    return row
  })
}

/** S5-2 优先级调整：立即生效 + 事件痕迹。 */
export function updateProject(db, id, patch, by) {
  const cur = getProject(db, id)
  const fields = {}
  if ('name' in patch) fields.name = patch.name
  if ('clientName' in patch) fields.client_name = patch.clientName || null
  if ('planStartDate' in patch) fields.plan_start_date = patch.planStartDate || null
  if ('planEndDate' in patch) fields.plan_end_date = patch.planEndDate || null
  if ('priority' in patch && patch.priority !== cur.priority) {
    fields.priority = assertValue('priority', patch.priority)
  }
  if ('status' in patch && patch.status !== cur.status) {
    const next = assertValue('projectStatus', patch.status)
    if (next === 'closed') throw Object.assign(new Error('结项走 closeProject（S8）'), { statusCode: 400 })
    fields.status = next
    if (next === 'active' && !cur.actual_start_date) fields.actual_start_date = new Date().toISOString().slice(0, 10)
  }
  if (!Object.keys(fields).length) return getProjectDetail(db, id)
  fields.updated_at = Date.now()
  const tx = db.transaction(() => {
    const sets = Object.keys(fields).map((k) => `${k} = @${k}`).join(', ')
    db.prepare(`UPDATE projects SET ${sets} WHERE id = @__id`).run({ ...fields, __id: id })
    if (fields.priority) {
      addEvent(db, {
        projectId: id, eventType: 'priority_change', nature: 'record', sourcePlatform: 'web', generatedBy: 'web',
        summary: `优先级 ${cur.priority} → ${fields.priority}（#${by}）`, speakerMemberId: by,
      })
    }
    if (fields.status) {
      addEvent(db, {
        projectId: id, eventType: 'status_change', nature: 'record', sourcePlatform: 'web', generatedBy: 'web',
        summary: `项目状态 ${cur.status} → ${fields.status}（#${by}）`, speakerMemberId: by,
      })
    }
    audit(db, { memberId: by, action: 'project.update', objectType: 'project', objectId: id, detail: { fields: Object.keys(patch) } })
  })
  tx()
  return getProjectDetail(db, id)
}

/**
 * S8 结项（v0.6）：所有任务标记「完成」后才允许结项（唯一终态）；生成复盘摘要并归档只读。
 */
export function closeProject(db, id, { summary } = {}, by) {
  const cur = getProject(db, id)
  if (cur.status === 'closed') throw Object.assign(new Error('项目已结项'), { statusCode: 409 })
  const openTasks = db
    .prepare(`SELECT id, title FROM tasks WHERE project_id = ? AND status != 'done'`)
    .all(id)
  if (openTasks.length) {
    throw Object.assign(new Error('存在未完成任务，全部标记完成后方可结项（S8-1，v0.6 无「取消」处置）'), {
      statusCode: 409, openTasks,
    })
  }
  const today = new Date().toISOString().slice(0, 10)
  const tx = db.transaction(() => {
    db.prepare('UPDATE milestones SET status = ? WHERE project_id = ? AND status = ?')
      .run('cancelled', id, 'planned')
    db.prepare('UPDATE projects SET status = ?, actual_end_date = ?, closeout_summary = ?, updated_at = ? WHERE id = ?')
      .run('closed', today, summary || '', Date.now(), id)
    addEvent(db, {
      projectId: id, eventType: 'decision', nature: 'record', sourcePlatform: 'web', generatedBy: 'system',
      summary: `项目结项${summary ? `：${summary}` : ''}`, speakerMemberId: by,
    })
    audit(db, { memberId: by, action: 'project.close', objectType: 'project', objectId: id })
  })
  tx()
  return getProjectDetail(db, id)
}

/** S1-3 管理员待办：未绑定任何专题渠道的在跑项目。 */
export function projectsWithoutChannel(db) {
  return camelizeRows(
    db.prepare(
      `SELECT p.id, p.name, p.priority, p.status, m.name AS lead_name FROM projects p
       LEFT JOIN members m ON m.id = p.lead_member_id
       WHERE p.status IN ('planning','active') AND NOT EXISTS (
         SELECT 1 FROM channels c WHERE c.project_id = p.id AND c.channel_type = 'dedicated')
       ORDER BY ${PRIORITY_ORDER}, p.id`
    ).all()
  )
}
