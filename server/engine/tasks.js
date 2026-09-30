import { camelizeRow, camelizeRows } from '../db/index.mjs'
import { assertValue } from './enums.js'
import { getProject } from './projects.js'
import { addEvent } from './events.js'
import { audit } from './auth.js'

const TASK_COLS = `t.*, m.name AS responsible_name, p.name AS project_name, p.status AS project_status`

function decorate(rows) {
  const today = todayStr()
  return rows.map((r) => ({
    ...camelizeRow(r),
    isOverdue: Boolean(r.plan_end_date && r.plan_end_date < today && r.status !== 'done'),
  }))
}

export function todayStr() {
  return new Date().toISOString().slice(0, 10)
}

export function getTask(db, id) {
  const row = db.prepare(`SELECT ${TASK_COLS} FROM tasks t LEFT JOIN members m ON m.id = t.responsible_member_id LEFT JOIN projects p ON p.id = t.project_id WHERE t.id = ?`).get(id)
  if (!row) throw Object.assign(new Error('任务不存在'), { statusCode: 404 })
  return decorate([row])[0]
}

export function listTasks(db, { projectId, responsibleMemberId, statuses } = {}) {
  const conds = []
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
       WHERE t.responsible_member_id IS NULL AND t.plan_start_date IS NOT NULL AND t.status IN ('todo','doing') ORDER BY t.plan_start_date`
    ).all()
  )
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
    .prepare('SELECT t.*, p.status AS project_status FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = ?')
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
    if (patch.status === 'done') fields.actual_end_date = todayStr()
  }
  if (!Object.keys(fields).length) return getTask(db, id)
  fields.updated_at = Date.now()
  const sets = Object.keys(fields).map((k) => `${k} = @${k}`).join(', ')
  db.prepare(`UPDATE tasks SET ${sets} WHERE id = @__id`).run({ ...fields, __id: id })
  audit(db, { memberId: by, action: 'task.update', objectType: 'task', objectId: id, detail: { fields: Object.keys(patch) } })
  return getTask(db, id)
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
    .prepare('SELECT t.id, p.status AS project_status FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = ?')
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

/** S7-1（v0.6 口径）：某人名下逾期未完任务清单。 */
export function overdueTasksOf(db, memberId) {
  return camelizeRows(
    db.prepare(
      `SELECT t.id, t.title, t.plan_end_date, p.id AS project_id, p.name AS project_name
       FROM tasks t JOIN projects p ON p.id = t.project_id
       WHERE t.responsible_member_id = ? AND t.status IN ('todo','doing') AND t.plan_end_date IS NOT NULL AND t.plan_end_date < date('now')`
    ).all(memberId)
  )
}

// —— 渠道（S1 绑定 / S3 抽取源；D5 通用群）——

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
  db.prepare(
    `INSERT INTO channels (platform, group_key, name, channel_type, project_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(platform, group_key) DO UPDATE SET name = excluded.name, channel_type = excluded.channel_type,
       project_id = excluded.project_id, updated_at = excluded.updated_at`
  ).run(platform, groupKey, name || null, channelType, channelType === 'dedicated' ? projectId : null, now, now)
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
