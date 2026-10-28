import { camelizeRow, camelizeRows } from '../db/index.mjs'
import { today, dayDiff, addDays } from '../db/time.js'
import { assertValue, label } from './enums.js'
import { addEvent } from './events.js'
import { audit } from './auth.js'
import { memberName } from './members.js'
import { resolveTypeForCreate, typeTaskItems, normalizeTypeTasks, normalizePromptText } from './projectTypes.js'
import { parseWeekdays } from './dailyBoard.js'

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
  // S69（v0.80，K64）：项目类别——delivery=交付项目（缺省）/ routine=常态项目（周视图每日打卡、
  // 无交付日期、结项豁免「全部任务完成」）；立项选定后不可变更（updateProject 拒绝）。
  const kind = input.kind == null || input.kind === '' ? 'delivery' : assertValue('projectKind', input.kind)
  const isRoutine = kind === 'routine'
  // S69-8（K65）：执行视图默认窗口（仅常态项目有意义；缺省 week，中央枚举校验）
  const boardSpan = isRoutine ? (input.boardSpan == null || input.boardSpan === '' ? 'week' : assertValue('boardSpan', input.boardSpan)) : 'week'
  if (isRoutine) {
    if (planStartDate || planEndDate) {
      throw Object.assign(new Error('常态项目无计划起止/交付日期（S69）——按周视图管理每日执行'), { statusCode: 400 })
    }
    if (autoSchedule) {
      throw Object.assign(new Error('常态项目不做倒排（无交付日期，S69）'), { statusCode: 400 })
    }
  }
  const lead = db.prepare(`SELECT id, name FROM members WHERE id = ? AND status = 'active'`).get(leadMemberId)
  if (!lead) throw Object.assign(new Error('牵头人不存在或已离职'), { statusCode: 400 })
  const type = resolveTypeForCreate(db, { typeCode, templateCode })
  const initExtra = normalizePromptText(input.initExtra, '初始分配补充要求') // S64：项目级补充要求（叠加类型 init_prompt）
  const customItems = normalizeTypeTasks(input.tasks)
  const items = customItems ?? typeTaskItems(db, type.id)
  const source = customItems !== undefined ? 'manual' : 'template'
  const titles = items.map((it) => it.title)
  const schedule = !isRoutine && autoSchedule ? backScheduleDates({ planStartDate, planEndDate, count: titles.length }) : null

  const now = Date.now()
  const created = db.transaction(() => {
    const info = db.prepare(
      `INSERT INTO projects (name, template_code, project_type_id, kind, board_span, status, priority, lead_member_id, client_name,
         plan_start_date, plan_end_date, actual_start_date, init_extra, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(name, type.code, type.id, kind, boardSpan, priority, leadMemberId, clientName || null,
      planStartDate || null, planEndDate || null, today(), initExtra ?? null, by ?? null, now, now)
    const projectId = Number(info.lastInsertRowid)
    const refCount = items.reduce((s, it) => s + it.refs.length, 0)
    const refStmt = db.prepare('INSERT INTO task_refs (task_id, title, url, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    items.forEach((item, i) => {
      const win = schedule?.[i]
      // S58：默认备注随任务拷贝（模板路径来自类型清单；自定义路径 normalizeTypeTasks 归一，未给为 NULL）
      // S69：常态项目任务一律 kind=routine（带适用星期，缺省每天；无计划起止）
      const taskWeekdays = isRoutine ? (item.weekdays ?? [1, 2, 3, 4, 5, 6, 7]) : null
      const taskInfo = db.prepare(
        `INSERT INTO tasks (project_id, title, note, responsible_member_id, status, plan_start_date, plan_end_date, kind, weekdays, source, created_at, updated_at)
         VALUES (?, ?, ?, NULL, 'todo', ?, ?, ?, ?, ?, ?, ?)`
      ).run(projectId, item.title, item.note ?? null,
        isRoutine ? null : (win ? win.planStartDate : (planStartDate || today())),
        isRoutine ? null : (win ? win.planEndDate : null),
        isRoutine ? 'routine' : 'work',
        taskWeekdays ? taskWeekdays.join(',') : null,
        source, now, now)
      // S33：模板/自定义任务的参考随标题拷贝进 task_refs（创建人=立项人；落表即被 S23 全套能力接管）
      item.refs.forEach((ref) => refStmt.run(Number(taskInfo.lastInsertRowid), ref.title, ref.url, ref.note, by ?? null, now))
    })
    for (const m of milestones) {
      db.prepare('INSERT INTO milestones (project_id, name, plan_date, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(projectId, m.name, m.planDate || null, 'planned', now, now)
    }
    addEvent(db, {
      projectId, eventType: 'decision', nature: 'record', sourcePlatform: 'web', generatedBy: 'web',
      summary: isRoutine
        ? `项目立项：常态项目（类型「${type.name}」· ${customItems !== undefined ? '自定义' : '预填'}常态任务 ${titles.length} 项，牵头人 ${lead.name}，按周视图每日打卡管理）`
        : `项目立项：类型「${type.name}」${customItems !== undefined ? `· 自定义任务 ${titles.length} 项` : `· 预填清单 ${titles.length} 项`}，牵头人 ${lead.name}${planEndDate ? `，计划 ${planStartDate || ''}~${planEndDate}` : ''}${schedule ? '，任务按交付日期倒排' : ''}${refCount ? `，预填参考资料 ${refCount} 条` : ''}`,
      speakerMemberId: by ?? null,
    })
    audit(db, { memberId: by, action: 'project.create', objectType: 'project', objectId: projectId, detail: { typeCode: type.code, kind, taskSource: source, tasks: titles.length, taskRefs: refCount, autoSchedule: Boolean(schedule) } })
    return projectId
  })
  const id = created()
  return getProjectDetail(db, id)
}

/**
 * S35-8（v0.76，K57）补任务预算（引擎生效与机器人软校验共用）：项目/类型守卫 + 类型清单 vs 项目既有未删任务
 * 标题精确比对 → { project, type, items, toAdd, skipped }。清单全部已存在也在此拒绝（400），让两侧拒绝文案同源。
 * 类型停用不阻断（类型只影响未来立项，v0.18/K11）。
 */
export function planTypeTasks(db, projectId) {
  const project = db.prepare('SELECT id, name, status, project_type_id FROM projects WHERE id = ?').get(Number(projectId))
  if (!project) throw Object.assign(new Error('项目不存在'), { statusCode: 404 })
  if (TERMINAL_STATUSES.includes(project.status)) throw Object.assign(new Error('项目已结项/取消，任务面只读'), { statusCode: 409 })
  const type = project.project_type_id
    ? db.prepare('SELECT id, code, name FROM project_types WHERE id = ?').get(project.project_type_id)
    : null
  if (!type) throw Object.assign(new Error('项目未绑定项目类型，无可补建的清单'), { statusCode: 400 })
  const items = typeTaskItems(db, type.id)
  if (!items.length) throw Object.assign(new Error(`项目类型「${type.name}」没有内嵌任务清单，无可补建`), { statusCode: 400 })
  const existing = new Set(
    db.prepare('SELECT title FROM tasks WHERE project_id = ? AND deleted_at IS NULL').all(project.id).map((r) => String(r.title).trim())
  )
  const toAdd = items.filter((it) => !existing.has(it.title.trim()))
  if (!toAdd.length) {
    throw Object.assign(new Error(`类型「${type.name}」清单 ${items.length} 项均已存在于项目，无需补建`), { statusCode: 400 })
  }
  const skipped = items.filter((it) => existing.has(it.title.trim())).map((it) => it.title)
  return { project, type, items, toAdd, skipped }
}

/**
 * S35-8（v0.76，K57）已有项目按自身类型清单补任务：与立项模板路径同口径拷入（source=template、todo、责任人未指派
 * （S38/K20）、计划开始=今天、计划结束空、默认备注与参考随标题同事务拷贝），同名未删任务跳过（可重放不建重复）。
 * 留痕=一条 decision 记录型事件 + 一条 project.applyTypeTasks 审计（不逐任务落进展，与 createProject 同模式）。
 * 排期与分配不在此做（走 S39/S64 初始分配）。platform 标注发起通道（web|bot|agent）。
 */
export function applyTypeTasks(db, projectId, by, { platform = 'web' } = {}) {
  const plan = planTypeTasks(db, projectId)
  const now = Date.now()
  const start = today()
  const tx = db.transaction(() => {
    const taskStmt = db.prepare(
      `INSERT INTO tasks (project_id, title, note, responsible_member_id, status, plan_start_date, plan_end_date, source, created_at, updated_at)
       VALUES (?, ?, ?, NULL, 'todo', ?, NULL, 'template', ?, ?)`
    )
    const refStmt = db.prepare('INSERT INTO task_refs (task_id, title, url, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    const taskIds = plan.toAdd.map((item) => {
      const taskId = Number(taskStmt.run(plan.project.id, item.title, item.note ?? null, start, now, now).lastInsertRowid)
      item.refs.forEach((ref) => refStmt.run(taskId, ref.title, ref.url, ref.note, by ?? null, now))
      return taskId
    })
    addEvent(db, {
      projectId: plan.project.id, eventType: 'decision', nature: 'record', sourcePlatform: platform, generatedBy: platform,
      summary: `按类型「${plan.type.name}」清单补建任务 ${taskIds.length} 项${plan.skipped.length ? `（跳过已存在 ${plan.skipped.length} 项）` : ''}`,
      speakerMemberId: by ?? null,
    })
    audit(db, {
      memberId: by, action: 'project.applyTypeTasks', objectType: 'project', objectId: plan.project.id,
      detail: { typeCode: plan.type.code, added: taskIds.length, skipped: plan.skipped.length, taskIds },
    })
    return taskIds
  })
  const taskIds = tx()
  return {
    projectId: plan.project.id, typeCode: plan.type.code, typeName: plan.type.name,
    added: taskIds.length, skipped: plan.skipped.length, skippedTitles: plan.skipped, taskIds,
  }
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
    weekdays: parseWeekdays(t.weekdays),
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

/** S5-1 全局列表：按优先级档位排序，含健康度要素（逾期数 / 最近实质更新）。S30-7（v0.79）起为 queryProjects 的数组薄壳。 */
export function listProjects(db, { statuses = OPEN_STATUSES } = {}) {
  return queryProjects(db, { statuses }).projects
}

/**
 * S30-7（v0.79，K62）服务端查询：项目组合页的筛选/排序/分页下沉到 SQL。
 * - q 模糊：按空白分词、各词 AND，须命中 项目名/客户名/牵头人名/类型名（含 template_code 兜底）任一，
 *   LIKE %词% + ESCAPE '\'（%/_ 按字面匹配；SQLite LIKE 对 ASCII 天然大小写不敏感）；
 * - sort ∈ priority（缺省）/delivery（进行中且填交付日期的按日升序，其余沉底——镜像前端 daysToDelivery ?? Infinity）
 *   /activity（最近事件降序、无事件沉底）/updated，服务端排序保证跨页有序；
 * - unscheduledOnly（双日期全空）/overdueOnly（有逾期任务）快捷过滤；
 * - page/pageSize 分页（路由层已校验 1~100）；不传分页参数=全量返回（Dashboard 等既有消费方）；
 * - 响应附 total（当前筛选全量计数）与 facets（byStatus/unscheduled/overdueTasks，仅受 q/priority 影响、
 *   不受状态选择影响——摘要芯片计数在分页下依然准确）。
 */
export const PROJECT_SORT_KEYS = ['priority', 'delivery', 'activity', 'updated']

const OVERDUE_TASKS_SUB = (alias = 'p') => `
  (SELECT COUNT(*) FROM tasks t WHERE t.project_id = ${alias}.id
     AND t.status IN ('todo','doing','blocked') AND t.deleted_at IS NULL AND t.kind = 'work'
     AND t.plan_end_date IS NOT NULL AND t.plan_end_date < BJ_TODAY())`

const SORT_ORDER = {
  priority: `${PRIORITY_ORDER}, p.updated_at DESC`,
  // 交付临近：进行中且填交付日期的按日升序在前，终态/无日期沉底成组不穿插（S30-2 语义进 SQL）
  delivery: `(p.status = 'active' AND p.plan_end_date IS NOT NULL) DESC, p.plan_end_date ASC, ${PRIORITY_ORDER}, p.updated_at DESC`,
  activity: `(last_event_at IS NULL), last_event_at DESC`, // 无事件沉底
  updated: 'p.updated_at DESC',
}

const LIKE_FIELDS = `p.name LIKE ? ESCAPE '\\' OR p.client_name LIKE ? ESCAPE '\\' OR m.name LIKE ? ESCAPE '\\' OR COALESCE(pt.name, p.template_code) LIKE ? ESCAPE '\\'`

function qTokens(q) {
  return String(q || '').split(/\s+/).map((t) => t.trim()).filter(Boolean)
}

/** q/priority → WHERE 片段（facets 基准也用它：不含状态选择）。 */
function softFilter({ q, priority }) {
  const where = []
  const args = []
  for (const tok of qTokens(q)) {
    const like = `%${tok.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
    where.push(`(${LIKE_FIELDS})`)
    args.push(like, like, like, like)
  }
  if (priority) {
    where.push('p.priority = ?')
    args.push(priority)
  }
  return { where, args }
}

export function queryProjects(db, {
  statuses = OPEN_STATUSES, q, priority, sort = 'priority',
  unscheduledOnly = false, overdueOnly = false, page, pageSize,
} = {}) {
  const soft = softFilter({ q, priority })
  const where = [`p.status IN (${statuses.map(() => '?').join(',')})`, ...soft.where]
  const args = [...statuses, ...soft.args]
  if (unscheduledOnly) where.push('(p.plan_start_date IS NULL AND p.plan_end_date IS NULL)')
  if (overdueOnly) where.push(`${OVERDUE_TASKS_SUB()} > 0`)

  const body = `
    FROM projects p LEFT JOIN members m ON m.id = p.lead_member_id
    LEFT JOIN project_types pt ON pt.id = p.project_type_id
    WHERE ${where.join(' AND ')}`
  const select = `
    SELECT p.*, m.name AS lead_name, pt.name AS type_name,
      ${OVERDUE_TASKS_SUB()} AS overdue_tasks,
      (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.deleted_at IS NULL AND t.kind = 'work') AS tasks_total,
      (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.deleted_at IS NULL AND t.kind = 'work' AND t.status = 'done') AS tasks_done,
      (SELECT MAX(e.business_time) FROM project_events e WHERE e.project_id = p.id AND e.status = 'effective') AS last_event_at`
  const order = PROJECT_SORT_KEYS.includes(sort) ? SORT_ORDER[sort] : SORT_ORDER.priority
  const limit = Number.isInteger(page) && Number.isInteger(pageSize) && pageSize > 0
    ? ` LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`
    : ''
  const rows = db.prepare(`${select}${body} ORDER BY ${order}${limit}`).all(...args)
  const total = db.prepare(`SELECT COUNT(*) AS n${body}`).get(...args).n

  // facets：三态计数/未排期/逾期任务总数——只受 q/priority 影响（状态选择/分页不改变芯片计数）
  const fwhere = soft.where.length ? soft.where.join(' AND ') : '1=1'
  const frows = db.prepare(`
    SELECT p.status, COUNT(*) AS n,
      SUM(CASE WHEN p.plan_start_date IS NULL AND p.plan_end_date IS NULL THEN 1 ELSE 0 END) AS unscheduled,
      SUM(${OVERDUE_TASKS_SUB()}) AS overdue_tasks
    FROM projects p LEFT JOIN members m ON m.id = p.lead_member_id
    LEFT JOIN project_types pt ON pt.id = p.project_type_id
    WHERE ${fwhere} GROUP BY p.status`).all(...soft.args)
  const facets = { byStatus: { active: 0, closed: 0, cancelled: 0 }, unscheduled: 0, overdueTasks: 0 }
  for (const r of frows) {
    facets.byStatus[r.status] = r.n
    facets.unscheduled += r.unscheduled
    facets.overdueTasks += r.overdue_tasks
  }
  return { projects: rows.map(shapeListRow), total, facets }
}

function shapeListRow(r) {
  const row = camelizeRow(r)
  row.silentDays = row.lastEventAt ? Math.floor((Date.now() - row.lastEventAt) / 86400000) : null
  row.daysToDelivery = daysToDelivery(r)
  return row
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
  // S69：项目类别立项选定后不可变更（两类项目的任务语义/视图/结项规则全然不同，K64）
  if ('kind' in patch) {
    throw Object.assign(new Error('项目类别（交付/常态）不可变更（S69）——如需另起一类项目请新建立项'), { statusCode: 400 })
  }
  if (cur.kind === 'routine' && (('planStartDate' in patch && patch.planStartDate) || ('planEndDate' in patch && patch.planEndDate))) {
    throw Object.assign(new Error('常态项目无计划起止/交付日期（S69）——按周视图管理每日执行'), { statusCode: 400 })
  }
  const fields = {}
  // S69-8（K65）：执行视图默认窗口——仅常态项目可设（交付项目视图与打卡无关），中央枚举校验
  if ('boardSpan' in patch) {
    if (cur.kind !== 'routine') {
      throw Object.assign(new Error('执行视图窗口仅常态项目可设置（S69-8）'), { statusCode: 400 })
    }
    fields.board_span = assertValue('boardSpan', patch.boardSpan)
  }
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
  // S64：项目级初始分配补充要求可后改（同类型 init_prompt 归一规则）
  const initExtra = normalizePromptText(patch.initExtra, '初始分配补充要求')
  if (initExtra !== undefined) fields.init_extra = initExtra
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
  // S69（v0.80，K64）：常态项目手动结项豁免「全部任务完成」——常态任务永不 done（模板行），
  // 不豁免则永远结不了项；结项总结必填不变（S29 结束留因原则与项目类别无关）。
  if (cur.kind !== 'routine') {
    const openTasks = db
      .prepare(`SELECT id, title FROM tasks WHERE project_id = ? AND status != 'done' AND deleted_at IS NULL`)
      .all(id)
    if (openTasks.length) {
      throw Object.assign(new Error('存在未完成任务，全部标记完成后方可结项（S8-1，v0.6 无「取消」处置）'), {
        statusCode: 409, openTasks,
      })
    }
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
