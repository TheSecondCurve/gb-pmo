import { camelizeRow, camelizeRows } from '../db/index.mjs'
import { today } from '../db/time.js'
import { assertValue, label } from './enums.js'
import { getProject } from './projects.js'
import { HTTP_URL } from './projectTypes.js'
import { addEvent } from './events.js'
import { audit } from './auth.js'

const TASK_COLS = `t.*, m.name AS responsible_name, p.name AS project_name, p.status AS project_status`

function decorate(rows) {
  return rows.map((r) => ({
    ...camelizeRow(r),
    isOverdue: Boolean(r.plan_end_date && r.plan_end_date < today() && r.status !== 'done'),
  }))
}

export function getTask(db, id) {
  const row = db.prepare(`SELECT ${TASK_COLS} FROM tasks t LEFT JOIN members m ON m.id = t.responsible_member_id LEFT JOIN projects p ON p.id = t.project_id WHERE t.id = ? AND t.deleted_at IS NULL`).get(id)
  if (!row) throw Object.assign(new Error('任务不存在'), { statusCode: 404 })
  return { ...decorate([row])[0], refs: listTaskRefs(db, id) }
}

export function listTasks(db, { projectId, responsibleMemberId, statuses } = {}) {
  const conds = ['t.deleted_at IS NULL']
  const params = []
  if (projectId) { conds.push('t.project_id = ?'); params.push(projectId) }
  if (responsibleMemberId) { conds.push('t.responsible_member_id = ?'); params.push(responsibleMemberId) }
  if (statuses?.length) { conds.push(`t.status IN (${statuses.map(() => '?').join(',')})`); params.push(...statuses) }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
  return decorate(
    db.prepare(`SELECT ${TASK_COLS} FROM tasks t LEFT JOIN members m ON m.id = t.responsible_member_id LEFT JOIN projects p ON p.id = t.project_id ${where} ORDER BY t.id`).all(...params)
  )
}

/** S2-1 未指派兜底视图：已设计划开始日但无责任人（默认路径责任人=牵头人，不该出现；出现即告警）。 */
export function listUnassigned(db) {
  return decorate(
    db.prepare(
      `SELECT ${TASK_COLS} FROM tasks t LEFT JOIN members m ON m.id = t.responsible_member_id LEFT JOIN projects p ON p.id = t.project_id
       WHERE t.responsible_member_id IS NULL AND t.plan_start_date IS NOT NULL AND t.status IN ('todo','doing') AND t.deleted_at IS NULL ORDER BY t.plan_start_date`
    ).all()
  )
}

const INV_MAX_PER_PROJECT = 40 // 盘点单项目列出的任务条数上限（模板任务 ≤30，防御性截断）

const invLine = (t) => `· #${t.id} ${t.title}（${label('taskStatus', t.status)}${t.plan_end_date ? `，截止 ${t.plan_end_date}` : ''}${t.responsible_name ? `，${t.responsible_name}` : ''}）`

/** S20-17 任务盘点（v0.34，/tasks 斜杠命令）：确定性组装，零 LLM。
 *  projectId 给定 → 该项目全部未完任务（未分配责任人段置顶 + 计数）；
 *  缺省 → 全部在跑项目的未分配责任人任务（按项目分组，全有主项目明确说明）。
 *  口径：未完 = status != 'done' 且 responsible_member_id IS NULL——宽于 S2-1 listUnassigned 的
 *  「已设开始日」兜底告警口径（那是异常检测，这是会议盘点视图，两者语义并存）。 */
export function tasksInventory(db, { projectId } = {}) {
  if (projectId) {
    const project = db.prepare('SELECT id, name FROM projects WHERE id = ?').get(projectId)
    if (!project) throw Object.assign(new Error('项目不存在'), { statusCode: 404 })
    const rows = db.prepare(
      `SELECT t.id, t.title, t.status, t.plan_end_date, m.name AS responsible_name
       FROM tasks t LEFT JOIN members m ON m.id = t.responsible_member_id
       WHERE t.project_id = ? AND t.status != 'done' AND t.deleted_at IS NULL ORDER BY t.id`
    ).all(projectId)
    const unassigned = rows.filter((t) => !t.responsible_name)
    const owned = rows.filter((t) => t.responsible_name)
    const lines = [`项目「${project.name}」任务盘点：未完 ${rows.length} 条，未分配责任人 ${unassigned.length} 条`, '']
    if (unassigned.length) {
      lines.push(`⚠ 未分配责任人（${unassigned.length}）：`)
      lines.push(...unassigned.slice(0, INV_MAX_PER_PROJECT).map(invLine))
      if (unassigned.length > INV_MAX_PER_PROJECT) lines.push(`（其余 ${unassigned.length - INV_MAX_PER_PROJECT} 条略）`)
      lines.push('')
    }
    if (owned.length) {
      lines.push(`已分配（${owned.length}）：`)
      lines.push(...owned.slice(0, INV_MAX_PER_PROJECT).map(invLine))
      if (owned.length > INV_MAX_PER_PROJECT) lines.push(`（其余 ${owned.length - INV_MAX_PER_PROJECT} 条略）`)
    }
    if (!unassigned.length && !owned.length) lines.push('（项目没有未完成任务）')
    return { text: lines.join('\n'), unassigned: unassigned.length, total: rows.length }
  }
  const projects = db.prepare(`SELECT id, name FROM projects WHERE status = 'active' ORDER BY id`).all()
  const byProject = new Map(projects.map((p) => [p.id, { name: p.name, rows: [] }]))
  const rows = db.prepare(
    `SELECT t.id, t.title, t.status, t.plan_end_date, t.project_id
     FROM tasks t JOIN projects p ON p.id = t.project_id
       WHERE t.responsible_member_id IS NULL AND t.status != 'done' AND t.deleted_at IS NULL AND p.status = 'active' ORDER BY t.project_id, t.id`
  ).all()
  for (const t of rows) byProject.get(t.project_id)?.rows.push(t)
  const total = rows.length
  const lines = [`在跑项目未分配责任人任务盘点：${projects.length} 个在跑项目，未分配 ${total} 条`, '']
  for (const { name, rows: list } of byProject.values()) {
    if (!list.length) { lines.push(`【${name}】均已分配`); continue }
    lines.push(`【${name}】${list.length} 条：`)
    lines.push(...list.slice(0, INV_MAX_PER_PROJECT).map(invLine))
    if (list.length > INV_MAX_PER_PROJECT) lines.push(`（其余 ${list.length - INV_MAX_PER_PROJECT} 条略）`)
    lines.push('')
  }
  if (!total) lines.push('在跑项目任务均已分配责任人。')
  return { text: lines.join('\n').trimEnd(), unassigned: total, totalProjects: projects.length }
}

export function createTask(db, input, by) {
  const { projectId, title, responsibleMemberId, planStartDate, planEndDate } = input
  if (!projectId || !title) throw Object.assign(new Error('projectId/title 必填'), { statusCode: 400 })
  const project = getProject(db, projectId)
  if (project.status === 'closed' || project.status === 'cancelled') {
    throw Object.assign(new Error('项目已结项/取消，任务面只读'), { statusCode: 409 })
  }
  // D3：未指派责任人时默认项目牵头人
  const owner = responsibleMemberId ?? project.leadMemberId
  const now = Date.now()
  const info = db.prepare(
    `INSERT INTO tasks (project_id, title, responsible_member_id, status, plan_start_date, plan_end_date, source, created_at, updated_at)
     VALUES (?, ?, ?, 'todo', ?, ?, 'manual', ?, ?)`
  ).run(projectId, title, owner, planStartDate || null, planEndDate || null, now, now)
  audit(db, { memberId: by, action: 'task.create', objectType: 'task', objectId: info.lastInsertRowid })
  return getTask(db, Number(info.lastInsertRowid))
}

export function updateTask(db, id, patch, by) {
  const cur = db
    .prepare('SELECT t.*, p.status AS project_status FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = ? AND t.deleted_at IS NULL')
    .get(id)
  if (!cur) throw Object.assign(new Error('任务不存在'), { statusCode: 404 })
  if (cur.project_status === 'closed' || cur.project_status === 'cancelled') {
    throw Object.assign(new Error('项目已结项/取消，任务面只读'), { statusCode: 409 })
  }
  const fields = {}
  if ('title' in patch) fields.title = patch.title
  if ('responsibleMemberId' in patch) {
    fields.responsible_member_id = patch.responsibleMemberId === '' ? null : patch.responsibleMemberId
    if (patch.responsibleMemberId && cur.responsible_member_id !== patch.responsibleMemberId) {
      // 责任人变更留痕（S4-4 语义，页面/Agent 同一通道）
      addEvent(db, {
        projectId: cur.project_id, eventType: 'owner_change', nature: 'record', sourcePlatform: 'web', generatedBy: 'web',
        summary: `任务「${cur.title}」责任人 #${cur.responsible_member_id} → #${patch.responsibleMemberId}`, speakerMemberId: by,
      })
    }
  }
  if ('planStartDate' in patch) fields.plan_start_date = patch.planStartDate || null
  if ('planEndDate' in patch) fields.plan_end_date = patch.planEndDate || null
  if ('status' in patch && patch.status !== cur.status) {
    fields.status = assertValue('taskStatus', patch.status)
    if (patch.status === 'done') fields.actual_end_date = today()
  }
  if (!Object.keys(fields).length) return getTask(db, id)
  fields.updated_at = Date.now()
  const sets = Object.keys(fields).map((k) => `${k} = @${k}`).join(', ')
  db.prepare(`UPDATE tasks SET ${sets} WHERE id = @__id`).run({ ...fields, __id: id })
  audit(db, { memberId: by, action: 'task.update', objectType: 'task', objectId: id, detail: { fields: Object.keys(patch) } })
  return getTask(db, id)
}

/**
 * 软删（S36，v0.40）：行保留、deleted_at 落值，同事务级联软删任务参考资料；
 * task_records 与讨论面历史事件保留（append-only 留痕）；结项/取消后不可删（S2-3 任务面只读继承）。
 * 全员可删（D1，web/Agent 同引擎同守卫）；留痕走 audit，不写 project_events（同 task_ref.delete 口径）。
 */
export function deleteTask(db, id, by) {
  const cur = db
    .prepare('SELECT t.*, p.status AS project_status FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = ? AND t.deleted_at IS NULL')
    .get(id)
  if (!cur) throw Object.assign(new Error('任务不存在'), { statusCode: 404 })
  if (cur.project_status === 'closed' || cur.project_status === 'cancelled') {
    throw Object.assign(new Error('项目已结项/取消，任务面只读'), { statusCode: 409 })
  }
  const now = Date.now()
  db.transaction(() => {
    db.prepare('UPDATE tasks SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now, now, id)
    db.prepare('UPDATE task_refs SET deleted_at = ? WHERE task_id = ? AND deleted_at IS NULL').run(now, id)
  })()
  audit(db, { memberId: by, action: 'task.delete', objectType: 'task', objectId: id, detail: { projectId: cur.project_id, title: cur.title } })
}

// —— 里程碑 ——

export function createMilestone(db, { projectId, name, planDate }, by) {
  if (!projectId || !name) throw Object.assign(new Error('projectId/name 必填'), { statusCode: 400 })
  const now = Date.now()
  const info = db.prepare(
    'INSERT INTO milestones (project_id, name, plan_date, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(projectId, name, planDate || null, 'planned', now, now)
  audit(db, { memberId: by, action: 'milestone.create', objectType: 'milestone', objectId: info.lastInsertRowid })
  return camelizeRow(db.prepare('SELECT * FROM milestones WHERE id = ?').get(Number(info.lastInsertRowid)))
}

export function updateMilestone(db, id, patch, by) {
  const cur = db.prepare('SELECT * FROM milestones WHERE id = ?').get(id)
  if (!cur) throw Object.assign(new Error('里程碑不存在'), { statusCode: 404 })
  const fields = {}
  if ('name' in patch) fields.name = patch.name
  if ('planDate' in patch) fields.plan_date = patch.planDate || null
  if ('actualDate' in patch) fields.actual_date = patch.actualDate || null
  if ('status' in patch) fields.status = assertValue('milestoneStatus', patch.status)
  if (!Object.keys(fields).length) return camelizeRow(cur)
  fields.updated_at = Date.now()
  const sets = Object.keys(fields).map((k) => `${k} = @${k}`).join(', ')
  db.prepare(`UPDATE milestones SET ${sets} WHERE id = @__id`).run({ ...fields, __id: id })
  audit(db, { memberId: by, action: 'milestone.update', objectType: 'milestone', objectId: id })
  return camelizeRow(db.prepare('SELECT * FROM milestones WHERE id = ?').get(id))
}

// —— 任务更新记录（S2-3，v0.6）：追加式，只插不改；项目归档后任务面只读 ——

export function addTaskRecord(db, { taskId, content }, by) {
  if (!taskId || !content || !String(content).trim()) {
    throw Object.assign(new Error('taskId/content 必填'), { statusCode: 400 })
  }
  const cur = db
    .prepare('SELECT t.id, p.status AS project_status FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = ? AND t.deleted_at IS NULL')
    .get(taskId)
  if (!cur) throw Object.assign(new Error('任务不存在'), { statusCode: 404 })
  if (cur.project_status === 'closed' || cur.project_status === 'cancelled') {
    throw Object.assign(new Error('项目已结项/取消，任务面只读'), { statusCode: 409 })
  }
  const info = db.prepare(
    'INSERT INTO task_records (task_id, member_id, content, created_at) VALUES (?, ?, ?, ?)'
  ).run(taskId, by ?? null, String(content).trim(), Date.now())
  audit(db, { memberId: by, action: 'task.record.create', objectType: 'task_record', objectId: info.lastInsertRowid })
  return listTaskRecords(db, taskId).find((r) => r.id === Number(info.lastInsertRowid))
}

export function listTaskRecords(db, taskId) {
  return camelizeRows(
    db.prepare(
      `SELECT r.*, m.name AS member_name FROM task_records r LEFT JOIN members m ON m.id = r.member_id
       WHERE r.task_id = ? ORDER BY r.created_at, r.id`
    ).all(taskId)
  )
}

// —— 任务参考资料（S23，v0.13）：SOP/知识库链接，手工维护；推送（日报/预警/个人梳理）附带给执行人 ——
// url 校验与类型模板侧同规则（S33）：HTTP_URL 单一真相源在 projectTypes.js（最底层，无环）。

export function listTaskRefs(db, taskId) {
  return camelizeRows(
    db.prepare(
      `SELECT r.*, m.name AS created_by_name FROM task_refs r LEFT JOIN members m ON m.id = r.created_by
       WHERE r.task_id = ? AND r.deleted_at IS NULL ORDER BY r.id`
    ).all(taskId)
  )
}

/** 批量取任务参考资料（推送用）：返回 taskId → 未删参考资料数组。 */
export function taskRefMap(db, taskIds) {
  if (!taskIds?.length) return new Map()
  const rows = db.prepare(
    `SELECT * FROM task_refs WHERE task_id IN (${taskIds.map(() => '?').join(',')}) AND deleted_at IS NULL ORDER BY id`
  ).all(...taskIds)
  const map = new Map()
  for (const r of rows) {
    const list = map.get(r.task_id) || []
    list.push(camelizeRow(r))
    map.set(r.task_id, list)
  }
  return map
}

/** 推送文本形态：`标题 链接`，多条以「；」相连。 */
export function formatTaskRefs(refs) {
  return (refs || []).map((r) => `${r.title} ${r.url}`).join('；')
}

function assertRefWritable(db, taskId) {
  const cur = db
    .prepare('SELECT t.id, p.status AS project_status FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = ? AND t.deleted_at IS NULL')
    .get(taskId)
  if (!cur) throw Object.assign(new Error('任务不存在'), { statusCode: 404 })
  if (cur.project_status === 'closed' || cur.project_status === 'cancelled') {
    throw Object.assign(new Error('项目已结项/取消，任务面只读'), { statusCode: 409 })
  }
}

export function addTaskRef(db, { taskId, title, url, note }, by) {
  if (!taskId || !String(title || '').trim() || !String(url || '').trim()) {
    throw Object.assign(new Error('taskId/title/url 必填'), { statusCode: 400 })
  }
  const cleanUrl = String(url).trim()
  if (!HTTP_URL.test(cleanUrl)) throw Object.assign(new Error('url 须为 http(s) 链接'), { statusCode: 400 })
  assertRefWritable(db, taskId)
  const info = db.prepare(
    'INSERT INTO task_refs (task_id, title, url, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(taskId, String(title).trim(), cleanUrl, note ? String(note).trim() : null, by ?? null, Date.now())
  audit(db, { memberId: by, action: 'task_ref.create', objectType: 'task_ref', objectId: info.lastInsertRowid, detail: { taskId } })
  return listTaskRefs(db, taskId).find((r) => r.id === Number(info.lastInsertRowid))
}

export function updateTaskRef(db, id, patch, by) {
  const cur = db.prepare('SELECT * FROM task_refs WHERE id = ? AND deleted_at IS NULL').get(id)
  if (!cur) throw Object.assign(new Error('参考资料不存在'), { statusCode: 404 })
  assertRefWritable(db, cur.task_id)
  const fields = {}
  if ('title' in patch) {
    if (!String(patch.title || '').trim()) throw Object.assign(new Error('title 不能为空'), { statusCode: 400 })
    fields.title = String(patch.title).trim()
  }
  if ('url' in patch) {
    if (!HTTP_URL.test(String(patch.url || '').trim())) throw Object.assign(new Error('url 须为 http(s) 链接'), { statusCode: 400 })
    fields.url = String(patch.url).trim()
  }
  if ('note' in patch) fields.note = patch.note ? String(patch.note).trim() : null
  if (!Object.keys(fields).length) return listTaskRefs(db, cur.task_id).find((r) => r.id === id)
  db.prepare(`UPDATE task_refs SET ${Object.keys(fields).map((k) => `${k} = @${k}`).join(', ')} WHERE id = @__id`).run({ ...fields, __id: id })
  audit(db, { memberId: by, action: 'task_ref.update', objectType: 'task_ref', objectId: id, detail: { fields: Object.keys(fields) } })
  return listTaskRefs(db, cur.task_id).find((r) => r.id === id)
}

/** 软删（S23-2）：行保留、deleted_at 落值；结项/取消后不可删（任务面只读）。 */
export function deleteTaskRef(db, id, by) {
  const cur = db.prepare('SELECT * FROM task_refs WHERE id = ? AND deleted_at IS NULL').get(id)
  if (!cur) throw Object.assign(new Error('参考资料不存在'), { statusCode: 404 })
  assertRefWritable(db, cur.task_id)
  db.prepare('UPDATE task_refs SET deleted_at = ? WHERE id = ?').run(Date.now(), id)
  audit(db, { memberId: by, action: 'task_ref.delete', objectType: 'task_ref', objectId: id })
}

/** S7-1（v0.6 口径；S29 修订）：某人名下逾期未完任务清单——只计进行中项目（终态项目任务已冻结退出预警口径）。 */
export function overdueTasksOf(db, memberId) {
  return camelizeRows(
    db.prepare(
      `SELECT t.id, t.title, t.plan_end_date, p.id AS project_id, p.name AS project_name
       FROM tasks t JOIN projects p ON p.id = t.project_id
       WHERE t.responsible_member_id = ? AND t.status IN ('todo','doing') AND t.deleted_at IS NULL AND p.status = 'active'
         AND t.plan_end_date IS NOT NULL AND t.plan_end_date < BJ_TODAY()`
    ).all(memberId)
  )
}

// —— 渠道（S1 绑定 / S3 抽取源；D5 通用群）——

/**
 * 渠道写权限（S17-12）：管理员全可；非管理员仅目标项目的牵头人可维护专题渠道；
 * 通用群（D5 属系统级配置）仅管理员。删除时目标=渠道当前绑定项目（canDeleteChannel）。
 */
export function canManageChannel(db, member, { channelType, projectId } = {}) {
  if (member?.role === 'admin') return true
  const pid = Number(projectId)
  if (channelType === 'dedicated' && Number.isInteger(pid)) {
    const p = db.prepare('SELECT lead_member_id FROM projects WHERE id = ?').get(pid)
    return p?.lead_member_id === member?.id
  }
  return false
}

export function canDeleteChannel(db, member, id) {
  if (member?.role === 'admin') return true
  const ch = db.prepare('SELECT channel_type, project_id FROM channels WHERE id = ?').get(id)
  if (!ch) return true // 渠道不存在，交给 deleteChannel 报 404
  return canManageChannel(db, member, { channelType: ch.channel_type, projectId: ch.project_id })
}

export function upsertChannel(db, { platform, groupKey, name, channelType = 'dedicated', projectId }, by) {
  assertValue('channelPlatform', platform)
  assertValue('channelType', channelType)
  if (!groupKey) throw Object.assign(new Error('groupKey 必填'), { statusCode: 400 })
  if (channelType === 'dedicated' && !projectId) {
    throw Object.assign(new Error('专题渠道必须绑定项目'), { statusCode: 400 })
  }
  if (channelType === 'general' && projectId) {
    throw Object.assign(new Error('通用群不绑定单一项目（由 LLM 分拣）'), { statusCode: 400 })
  }
  const now = Date.now()
  // 新建绑定 cursor=绑定时刻：任一入口首拉只处理绑定之后的聊天，不回灌历史（S3-6/v0.24）；
  // 已绑定渠道更新（改名/改绑/改类型）不在此重置游标——回看历史只能走 resetChannelCursor。
  db.prepare(
    `INSERT INTO channels (platform, group_key, name, channel_type, project_id, cursor, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(platform, group_key) DO UPDATE SET name = excluded.name, channel_type = excluded.channel_type,
       project_id = excluded.project_id, updated_at = excluded.updated_at`
  ).run(platform, groupKey, name || null, channelType, channelType === 'dedicated' ? projectId : null, String(Math.floor(now / 1000)), now, now)
  audit(db, { memberId: by, action: 'channel.upsert', objectType: 'channel', objectId: `${platform}:${groupKey}` })
  return camelizeRow(db.prepare('SELECT * FROM channels WHERE platform = ? AND group_key = ?').get(platform, groupKey))
}

export function listChannels(db) {
  return camelizeRows(
    db.prepare(
      `SELECT c.*, p.name AS project_name FROM channels c LEFT JOIN projects p ON p.id = c.project_id ORDER BY c.id`
    ).all()
  )
}

export function deleteChannel(db, id, by) {
  db.prepare('DELETE FROM channels WHERE id = ?').run(id)
  audit(db, { memberId: by, action: 'channel.delete', objectType: 'channel', objectId: id })
}

/**
 * 渠道游标重置（S17-10）：回看 N 天（1~90，默认 7），供管理员反复重读同一群做验证调试。
 * 注意：消息未落库（仅事件 append-only），重放会生成新事件流，历史事件不动。
 */
export function resetChannelCursor(db, id, { days = 7 } = {}, by) {
  const ch = db.prepare('SELECT * FROM channels WHERE id = ?').get(id)
  if (!ch) throw Object.assign(new Error('渠道不存在'), { statusCode: 404 })
  if (!Number.isInteger(days) || days < 1 || days > 90) {
    throw Object.assign(new Error('days 须为 1~90 的整数'), { statusCode: 400 })
  }
  const cursorSec = Math.floor((Date.now() - days * 86_400_000) / 1000)
  db.prepare('UPDATE channels SET cursor = ?, updated_at = ? WHERE id = ?').run(String(cursorSec), Date.now(), id)
  audit(db, { memberId: by, action: 'channel.cursorReset', objectType: 'channel', objectId: id, detail: { days, from: ch.cursor } })
  return camelizeRow(db.prepare('SELECT * FROM channels WHERE id = ?').get(id))
}
