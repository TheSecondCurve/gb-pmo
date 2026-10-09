import { camelizeRow, camelizeRows } from '../db/index.mjs'
import { today, dayDiff, addDays } from '../db/time.js'
import { assertValue, label } from './enums.js'
import { addEvent } from './events.js'
import { audit } from './auth.js'
import { memberName } from './members.js'
import { resolveTypeForCreate, typeTaskItems, normalizeTypeTasks } from './projectTypes.js'

const OPEN_STATUSES = ['active'] // S29（v0.28）三态：进行中→已结项/已取消
const TERMINAL_STATUSES = ['closed', 'cancelled']
const PRIORITY_ORDER = `CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END`

/**
 * S21 剩余/超期天数：交付日期在今天的日历日差（未来为正、已过为负=超期天数）；
 * 结项/取消（周期已结束）或无交付日期时为 null。北京日历日口径（S19）。
 */
export function daysToDelivery(p) {
  if (p.status === 'closed' || p.status === 'cancelled' || !p.plan_end_date) return null
  return dayDiff(today(), p.plan_end_date)
}

/** S29：终态项目待确认建议批量过期（结束即冻结建议流转，confirmEvent 另有终态守卫双保险）。 */
function expirePendingSuggestions(db, projectId) {
  db.prepare(`UPDATE project_events SET status = 'expired', decided_at = ? WHERE project_id = ? AND status = 'pending' AND nature = 'suggestion'`)
    .run(Date.now(), projectId)
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
 * S1 立项（v0.18；S29 修订）：选项目类型 → 按其内嵌任务清单实例化（source=template）；
 * 载荷显式给 tasks（标题数组或 {title, refs} 数组，S33）→ 覆盖实例化（source=manual，允许空清单，S1-6；
 * 纯标题=不带模板参考，显式 refs 才带）；autoSchedule=true → 按 [计划开始（缺省今天）→ 交付日期]
 * 均分倒排任务计划起止（S1-7）。模板任务的参考随标题同事务拷贝进 task_refs（创建人=立项人，S23 全套接管）。
 * templateCode 为 typeCode 的兼容别名（同码解析）。牵头人必填；任务责任人默认未指派（v0.42/S38 推翻 D3，K20）。
 * S29：立项即「进行中」，启动日=立项日自动落（不再有待启动/已暂停）。
 */
export function createProject(db, input, by) {
  const { name, typeCode, templateCode, leadMemberId, priority = 'medium', clientName,
    planStartDate, planEndDate, milestones = [], autoSchedule } = input
  if (!name) throw Object.assign(new Error('项目名必填'), { statusCode: 400 })
  if (!leadMemberId) throw Object.assign(new Error('牵头人必填（S1-1）'), { statusCode: 400 })
  assertValue('priority', priority)
  const lead = db.prepare(`SELECT id, name FROM members WHERE id = ? AND status = 'active'`).get(leadMemberId)
  if (!lead) throw Object.assign(new Error('牵头人不存在或已离职'), { statusCode: 400 })
  const type = resolveTypeForCreate(db, { typeCode, templateCode })
  const customItems = normalizeTypeTasks(input.tasks)
  const items = customItems ?? typeTaskItems(db, type.id)
  const source = customItems !== undefined ? 'manual' : 'template'
  const titles = items.map((it) => it.title)
  const schedule = autoSchedule ? backScheduleDates({ planStartDate, planEndDate, count: titles.length }) : null

  const now = Date.now()
  const created = db.transaction(() => {
    const info = db.prepare(
      `INSERT INTO projects (name, template_code, project_type_id, status, priority, lead_member_id, client_name,
         plan_start_date, plan_end_date, actual_start_date, created_by, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(name, type.code, type.id, priority, leadMemberId, clientName || null,
      planStartDate || null, planEndDate || null, today(), by ?? null, now, now)
    const projectId = Number(info.lastInsertRowid)
    const refCount = items.reduce((s, it) => s + it.refs.length, 0)
    const refStmt = db.prepare('INSERT INTO task_refs (task_id, title, url, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    items.forEach((item, i) => {
      const win = schedule?.[i]
      const taskInfo = db.prepare(
        `INSERT INTO tasks (project_id, title, responsible_member_id, status, plan_start_date, plan_end_date, source, created_at, updated_at)
         VALUES (?, ?, NULL, 'todo', ?, ?, ?, ?, ?)`
      ).run(projectId, item.title, win ? win.planStartDate : (planStartDate || today()), win ? win.planEndDate : null, source, now, now)
      // S33：模板/自定义任务的参考随标题拷贝进 task_refs（创建人=立项人；落表即被 S23 全套能力接管）
      item.refs.forEach((ref) => refStmt.run(Number(taskInfo.lastInsertRowid), ref.title, ref.url, ref.note, by ?? null, now))
    })
    for (const m of milestones) {
      db.prepare('INSERT INTO milestones (project_id, name, plan_date, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(projectId, m.name, m.planDate || null, 'planned', now, now)
    }
    addEvent(db, {
      projectId, eventType: 'decision', nature: 'record', sourcePlatform: 'web', generatedBy: 'web',
      summary: `项目立项：类型「${type.name}」${customItems !== undefined ? `· 自定义任务 ${titles.length} 项` : `· 预填清单 ${titles.length} 项`}，牵头人 ${lead.name}${planEndDate ? `，计划 ${planStartDate || ''}~${planEndDate}` : ''}${schedule ? '，任务按交付日期倒排' : ''}${refCount ? `，预填参考资料 ${refCount} 条` : ''}`,
      speakerMemberId: by ?? null,
    })
    audit(db, { memberId: by, action: 'project.create', objectType: 'project', objectId: projectId, detail: { typeCode: type.code, taskSource: source, tasks: titles.length, taskRefs: refCount, autoSchedule: Boolean(autoSchedule) } })
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
       WHERE t.project_id = ? AND t.deleted_at IS NULL ORDER BY t.id`
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
            AND t.deleted_at IS NULL AND t.plan_end_date IS NOT NULL AND t.plan_end_date < BJ_TODAY()) AS overdue_tasks,
         (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.deleted_at IS NULL) AS tasks_total,
         (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.deleted_at IS NULL AND t.status = 'done') AS tasks_done,
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

/** S5-2 优先级调整等字段维护：立即生效 + 事件痕迹。S29：不再受理 status（状态仅经结项/取消变更）；终态项目只读。 */
export function updateProject(db, id, patch, by) {
  const cur = getProject(db, id)
  if (TERMINAL_STATUSES.includes(cur.status)) {
    throw Object.assign(new Error(`项目已${cur.status === 'closed' ? '结项' : '取消'}，归档只读（S29 终态不可逆）`), { statusCode: 409 })
  }
  if ('status' in patch) {
    throw Object.assign(new Error('项目状态仅可经结项/取消变更（S29）：请走 POST /projects/:id/close|cancel'), { statusCode: 400 })
  }
  const fields = {}
  if ('name' in patch) fields.name = patch.name
  if ('clientName' in patch) fields.client_name = patch.clientName || null
  if ('planStartDate' in patch) fields.plan_start_date = patch.planStartDate || null
  if ('planEndDate' in patch) fields.plan_end_date = patch.planEndDate || null
  if ('priority' in patch && patch.priority !== cur.priority) {
    fields.priority = assertValue('priority', patch.priority)
  }
  // S35（v0.39）换牵头人补全：此前无任何通道可改；新牵头人须在职，变更落 owner_change 留痕
  if ('leadMemberId' in patch && patch.leadMemberId !== cur.leadMemberId) {
    const lead = db.prepare(`SELECT id FROM members WHERE id = ? AND status = 'active'`).get(Number(patch.leadMemberId))
    if (!lead) throw Object.assign(new Error('新牵头人不存在或已离职'), { statusCode: 400 })
    fields.lead_member_id = lead.id
  }
  if (!Object.keys(fields).length) return getProjectDetail(db, id)
  fields.updated_at = Date.now()
  const tx = db.transaction(() => {
    const sets = Object.keys(fields).map((k) => `${k} = @${k}`).join(', ')
    db.prepare(`UPDATE projects SET ${sets} WHERE id = @__id`).run({ ...fields, __id: id })
    if (fields.priority) {
      // S4-10（v0.47）：留痕摘要写中文档位与操作人姓名，不写枚举键/成员编号
      addEvent(db, {
        projectId: id, eventType: 'priority_change', nature: 'record', sourcePlatform: 'web', generatedBy: 'web',
        summary: `优先级 ${label('priority', cur.priority)} → ${label('priority', fields.priority)}（${memberName(db, by)}）`, speakerMemberId: by,
      })
    }
    if (fields.lead_member_id) {
      addEvent(db, {
        projectId: id, eventType: 'owner_change', nature: 'record', sourcePlatform: 'web', generatedBy: 'web',
        summary: `项目牵头人 ${memberName(db, cur.leadMemberId)} → ${memberName(db, fields.lead_member_id)}（${memberName(db, by)}）`, speakerMemberId: by,
      })
    }
    audit(db, { memberId: by, action: 'project.update', objectType: 'project', objectId: id, detail: { fields: Object.keys(patch) } })
  })
  tx()
  return getProjectDetail(db, id)
}

/**
 * S8 结项（v0.6；S29 修订）：所有任务标记「完成」后才允许结项（唯一终态）；
 * 结项总结必填（可先取 brain/digest.closeoutSummary 的 AI 草稿、人工改后提交）；
 * 落实际结束日、计划中里程碑转已取消、待确认建议批量过期、归档只读，终态不可逆。
 */
export function closeProject(db, id, { summary } = {}, by) {
  const cur = getProject(db, id)
  if (TERMINAL_STATUSES.includes(cur.status)) {
    throw Object.assign(new Error(`项目已${cur.status === 'closed' ? '结项' : '取消'}（S29 终态不可逆）`), { statusCode: 409 })
  }
  const openTasks = db
    .prepare(`SELECT id, title FROM tasks WHERE project_id = ? AND status != 'done' AND deleted_at IS NULL`)
    .all(id)
  if (openTasks.length) {
    throw Object.assign(new Error('存在未完成任务，全部标记完成后方可结项（S8-1，v0.6 无「取消」处置）'), {
      statusCode: 409, openTasks,
    })
  }
  const text = String(summary || '').trim()
  if (!text) throw Object.assign(new Error('结项总结必填（S29：结束项目必须留原因文本；可先取 AI 复盘草稿改后提交）'), { statusCode: 400 })
  const tx = db.transaction(() => {
    db.prepare('UPDATE milestones SET status = ? WHERE project_id = ? AND status = ?')
      .run('cancelled', id, 'planned')
    db.prepare('UPDATE projects SET status = ?, actual_end_date = ?, closeout_summary = ?, updated_at = ? WHERE id = ?')
      .run('closed', today(), text, Date.now(), id)
    expirePendingSuggestions(db, id)
    addEvent(db, {
      projectId: id, eventType: 'decision', nature: 'record', sourcePlatform: 'web', generatedBy: 'system',
      summary: `项目结项：${text}`, speakerMemberId: by,
    })
    audit(db, { memberId: by, action: 'project.close', objectType: 'project', objectId: id })
  })
  tx()
  return getProjectDetail(db, id)
}

/**
 * S8-3 / S29 取消项目：原因必填；未完任务原样冻结（v0.6 任务无取消态的裁剪不变，靠口径过滤退出
 * 预警/梳理/指标）；落实际结束日、计划中里程碑转已取消、待确认建议批量过期、归档只读，终态不可逆。
 */
export function cancelProject(db, id, { reason } = {}, by) {
  const cur = getProject(db, id)
  if (TERMINAL_STATUSES.includes(cur.status)) {
    throw Object.assign(new Error(`项目已${cur.status === 'closed' ? '结项' : '取消'}（S29 终态不可逆）`), { statusCode: 409 })
  }
  const text = String(reason || '').trim()
  if (!text) throw Object.assign(new Error('取消原因必填（S29：结束项目必须留原因文本）'), { statusCode: 400 })
  const tx = db.transaction(() => {
    db.prepare('UPDATE milestones SET status = ? WHERE project_id = ? AND status = ?')
      .run('cancelled', id, 'planned')
    db.prepare('UPDATE projects SET status = ?, actual_end_date = ?, closeout_summary = ?, updated_at = ? WHERE id = ?')
      .run('cancelled', today(), text, Date.now(), id)
    expirePendingSuggestions(db, id)
    addEvent(db, {
      projectId: id, eventType: 'decision', nature: 'record', sourcePlatform: 'web', generatedBy: 'system',
      summary: `项目取消：${text}`, speakerMemberId: by,
    })
    audit(db, { memberId: by, action: 'project.cancel', objectType: 'project', objectId: id })
  })
  tx()
  return getProjectDetail(db, id)
}

/**
 * 硬删除（S37，v0.41 / K19：软删约定的唯一例外）：物理抹除项目及其任务面/讨论面全部数据。
 * 与「取消」互补——取消是业务终态留痕，硬删是数据清理手段（测试/演示/误建）。
 * FK ON 下同事务按序级联；分拣暂存/推送历史行保留、引用置 NULL（审计语义）；
 * 飞书侧日历事件/群聊不追回（外部资源）。唯一痕迹 = project.hardDelete 审计快照。
 * 权限在路由层收敛 admin-only（web requireAdmin / Agent adminOnly）；任意状态可直接删。
 */
export function deleteProjectHard(db, id, by) {
  const cur = db.prepare('SELECT * FROM projects WHERE id = ?').get(id)
  if (!cur) throw Object.assign(new Error('项目不存在'), { statusCode: 404 })
  const counts = {
    tasks: db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE project_id = ?').get(id).n,
    events: db.prepare('SELECT COUNT(*) AS n FROM project_events WHERE project_id = ?').get(id).n,
  }
  db.transaction(() => {
    // events.target_task_id 引用 tasks——先删讨论面，再删任务面
    db.prepare('DELETE FROM project_events WHERE project_id = ?').run(id)
    db.prepare('DELETE FROM task_refs WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)').run(id)
    db.prepare('DELETE FROM task_records WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)').run(id)
    db.prepare('DELETE FROM tasks WHERE project_id = ?').run(id)
    db.prepare('DELETE FROM milestones WHERE project_id = ?').run(id)
    db.prepare('DELETE FROM channels WHERE project_id = ?').run(id)
    db.prepare('DELETE FROM calendar_sync WHERE project_id = ?').run(id)
    db.prepare('UPDATE unrouted_messages SET routed_project_id = NULL WHERE routed_project_id = ?').run(id)
    db.prepare('UPDATE pushes SET related_project_id = NULL WHERE related_project_id = ?').run(id)
    db.prepare('DELETE FROM projects WHERE id = ?').run(id)
  })()
  audit(db, {
    memberId: by, action: 'project.hardDelete', objectType: 'project', objectId: id,
    detail: { name: cur.name, status: cur.status, ...counts },
  })
}

/** S1-3 管理员待办：未绑定任何专题渠道的在跑项目。 */
export function projectsWithoutChannel(db) {
  return camelizeRows(
    db.prepare(
      `SELECT p.id, p.name, p.priority, p.status, m.name AS lead_name FROM projects p
       LEFT JOIN members m ON m.id = p.lead_member_id
       WHERE p.status = 'active' AND NOT EXISTS (
         SELECT 1 FROM channels c WHERE c.project_id = p.id AND c.channel_type = 'dedicated')
       ORDER BY ${PRIORITY_ORDER}, p.id`
    ).all()
  )
}
