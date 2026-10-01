import { camelizeRow, camelizeRows } from '../db/index.mjs'
import { today, dayDiff, addDays } from '../db/time.js'
import { assertValue } from './enums.js'
import { addEvent } from './events.js'
import { audit } from './auth.js'
import { resolveTypeForCreate, typeTaskTitles, normalizeTaskTitles } from './projectTypes.js'

const OPEN_STATUSES = ['planning', 'active', 'paused']
const IN_CYCLE_STATUSES = ['active', 'paused'] // 已进入交付周期（S21）
const PRIORITY_ORDER = `CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END`

/**
 * S21 剩余/超期天数：交付日期在今天的日历日差（未来为正、已过为负=超期天数）；
 * 结项/取消（周期已结束）或无交付日期时为 null。北京日历日口径（S19）。
 */
export function daysToDelivery(p) {
  if (p.status === 'closed' || p.status === 'cancelled' || !p.plan_end_date) return null
  return dayDiff(today(), p.plan_end_date)
}

/**
 * S1-7 倒排期（v0.18）：按「起点 → 交付日期」对 N 条任务均分倒排计划起止。
 * 纯确定性算术（LLM 不做日期数学）：第 i 条截止 = 起点 + ⌈(i+1)·总天数/N⌉ 日（末条=交付日期）；
 * 第 i 条开始 = 上一条截止 + 1 日，且不晚于自身截止（窗口短于任务数时钳到同日）。
 * 北京日历日（S19）；只发生在立项瞬间，非重排求解器（PRD §9 边界）。
 */
export function backScheduleDates({ planStartDate, planEndDate, count }) {
  if (!planEndDate) throw Object.assign(new Error('倒排须填交付日期（planEndDate）'), { statusCode: 400 })
  const start = planStartDate || today()
  const total = Math.max(0, dayDiff(start, planEndDate))
  const out = []
  for (let i = 0; i < count; i++) {
    const due = addDays(start, Math.ceil(((i + 1) * total) / count))
    const begin = i === 0 ? start : addDays(out[i - 1].planEndDate, 1)
    out.push({ planStartDate: begin > due ? due : begin, planEndDate: due })
  }
  return out
}

/**
 * S1 立项（v0.18）：选项目类型 → 按其内嵌任务清单实例化（source=template）；
 * 载荷显式给 tasks（标题数组）→ 覆盖实例化（source=manual，允许空清单，S1-6）；
 * autoSchedule=true → 按 [计划开始（缺省今天）→ 交付日期] 均分倒排任务计划起止（S1-7）。
 * templateCode 为 typeCode 的兼容别名（同码解析）。牵头人必填、任务默认责任人=牵头人（D3）。
 */
export function createProject(db, input, by) {
  const { name, typeCode, templateCode, leadMemberId, priority = 'medium', clientName,
    planStartDate, planEndDate, milestones = [], autoSchedule } = input
  if (!name) throw Object.assign(new Error('项目名必填'), { statusCode: 400 })
  if (!leadMemberId) throw Object.assign(new Error('牵头人必填（S1-1）'), { statusCode: 400 })
  assertValue('priority', priority)
  const lead = db.prepare(`SELECT id FROM members WHERE id = ? AND status = 'active'`).get(leadMemberId)
  if (!lead) throw Object.assign(new Error('牵头人不存在或已离职'), { statusCode: 400 })
  const type = resolveTypeForCreate(db, { typeCode, templateCode })
  const customTitles = normalizeTaskTitles(input.tasks)
  const titles = customTitles ?? typeTaskTitles(db, type.id)
  const source = customTitles !== undefined ? 'manual' : 'template'
  const schedule = autoSchedule ? backScheduleDates({ planStartDate, planEndDate, count: titles.length }) : null

  const now = Date.now()
  const created = db.transaction(() => {
    const info = db.prepare(
      `INSERT INTO projects (name, template_code, project_type_id, status, priority, lead_member_id, client_name,
         plan_start_date, plan_end_date, actual_start_date, created_by, created_at, updated_at)
       VALUES (?, ?, ?, 'planning', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(name, type.code, type.id, priority, leadMemberId, clientName || null,
      planStartDate || null, planEndDate || null, null, by ?? null, now, now)
    const projectId = Number(info.lastInsertRowid)

    titles.forEach((title, i) => {
      const win = schedule?.[i]
      db.prepare(
        `INSERT INTO tasks (project_id, title, responsible_member_id, status, plan_start_date, plan_end_date, source, created_at, updated_at)
         VALUES (?, ?, ?, 'todo', ?, ?, ?, ?, ?)`
      ).run(projectId, title, leadMemberId, win ? win.planStartDate : (planStartDate || today()), win ? win.planEndDate : null, source, now, now)
    })
    for (const m of milestones) {
      db.prepare('INSERT INTO milestones (project_id, name, plan_date, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(projectId, m.name, m.planDate || null, 'planned', now, now)
    }
    addEvent(db, {
      projectId, eventType: 'decision', nature: 'record', sourcePlatform: 'web', generatedBy: 'web',
      summary: `项目立项：类型「${type.name}」${customTitles !== undefined ? `· 自定义任务 ${titles.length} 项` : `· 预填清单 ${titles.length} 项`}，牵头人 #${leadMemberId}${planEndDate ? `，计划 ${planStartDate || ''}~${planEndDate}` : ''}${schedule ? '，任务按交付日期倒排' : ''}`,
      speakerMemberId: by ?? null,
    })
    audit(db, { memberId: by, action: 'project.create', objectType: 'project', objectId: projectId, detail: { typeCode: type.code, taskSource: source, tasks: titles.length, autoSchedule: Boolean(autoSchedule) } })
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
      `SELECT t.*, m.name AS responsible_name,
         (SELECT COUNT(*) FROM task_refs r WHERE r.task_id = t.id AND r.deleted_at IS NULL) AS ref_count
       FROM tasks t LEFT JOIN members m ON m.id = t.responsible_member_id
       WHERE t.project_id = ? ORDER BY t.id`
    )
    .all(id)
  const taskRows = tasks.map((t) => ({
    ...camelizeRow(t),
    isOverdue: Boolean(t.plan_end_date && t.plan_end_date < today() && t.status !== 'done'),
  }))
  return {
    ...camelizeRow(p),
    daysToDelivery: daysToDelivery(p),
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
            AND t.plan_end_date IS NOT NULL AND t.plan_end_date < BJ_TODAY()) AS overdue_tasks,
         (SELECT MAX(e.business_time) FROM project_events e WHERE e.project_id = p.id AND e.status = 'effective') AS last_event_at
       FROM projects p LEFT JOIN members m ON m.id = p.lead_member_id
       LEFT JOIN project_types pt ON pt.id = p.project_type_id
       WHERE p.status IN (${ph})
       ORDER BY ${PRIORITY_ORDER}, p.updated_at DESC`
    )
    .all(...statuses)
  return rows.map((r) => {
    const row = camelizeRow(r)
    row.silentDays = row.lastEventAt ? Math.floor((Date.now() - row.lastEventAt) / 86400000) : null
    row.daysToDelivery = daysToDelivery(r)
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
    // cur 为 camelCase 行；启动日=首次激活落定，暂停后重启不重置（S21 交付周期起点）
    if (next === 'active' && !cur.actualStartDate) fields.actual_start_date = today()
  }
  // S21：交付日期一等公民——切「进行中」必须有交付日期（同请求补齐亦放行）；
  // 已进入交付周期（进行中/已暂停）的项目不可清空交付日期。
  const nextStatus = fields.status || cur.status
  const nextEndDate = 'plan_end_date' in fields ? fields.plan_end_date : cur.planEndDate
  if (nextStatus === 'active' && !nextEndDate) {
    throw Object.assign(new Error('未填交付日期（S21-1）：进行中项目 = 启动日→交付日期的交付周期，请先填交付日期'), { statusCode: 400 })
  }
  if (!nextEndDate && IN_CYCLE_STATUSES.includes(nextStatus) && IN_CYCLE_STATUSES.includes(cur.status)) {
    throw Object.assign(new Error('交付日期不可清空（S21-3）：项目已进入交付周期（进行中/已暂停）'), { statusCode: 400 })
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
  const tx = db.transaction(() => {
    db.prepare('UPDATE milestones SET status = ? WHERE project_id = ? AND status = ?')
      .run('cancelled', id, 'planned')
    db.prepare('UPDATE projects SET status = ?, actual_end_date = ?, closeout_summary = ?, updated_at = ? WHERE id = ?')
      .run('closed', today(), summary || '', Date.now(), id)
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
