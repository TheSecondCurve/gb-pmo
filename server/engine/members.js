import { camelizeRow, camelizeRows } from '../db/index.mjs'
import { hashPassword, publicMember, revokeMemberTokens, audit } from './auth.js'
import { assertValue } from './enums.js'

const COLS = 'id, name, username, feishu_id, wecom_id, team, is_key_person, max_parallel_projects, role, status, created_at, updated_at'

/** S17-7：调用前先确认当前操作确实在移除一名在职系统管理员，否则会误拦普通变更。 */
function assertNotLastAdmin(db) {
  const admins = db.prepare(`SELECT COUNT(*) AS n FROM members WHERE role = 'admin' AND status = 'active'`).get().n
  if (admins <= 1) {
    throw Object.assign(
      new Error('这是最后一名在职系统管理员，不能降级或离职；请先在用户管理中把其他成员设为系统管理员'),
      { statusCode: 409 }
    )
  }
}

export function getMember(db, id) {
  return publicMember(camelizeRow(db.prepare(`SELECT ${COLS} FROM members WHERE id = ?`).get(id)))
}

/** S4-10（v0.47）：留痕摘要的成员姓名快照——事件 append-only 历史不回改，写时落定姓名；null=未指派，查不到防御性回退编号。 */
export function memberName(db, id) {
  if (id == null) return '未指派'
  const row = db.prepare('SELECT name FROM members WHERE id = ?').get(id)
  return row?.name || `成员#${id}`
}

export function listMembers(db, { activeOnly = false } = {}) {
  const sql = activeOnly
    ? `SELECT ${COLS} FROM members WHERE status = 'active' ORDER BY id`
    : `SELECT ${COLS} FROM members ORDER BY id`
  return camelizeRows(db.prepare(sql).all()).map(publicMember)
}

export function createMember(db, input, by) {
  const { name, username, password, feishuId, wecomId, team, isKeyPerson = 0, maxParallelProjects = 3, role = 'member' } = input
  if (!name || !username || !password) {
    throw Object.assign(new Error('name/username/password 必填'), { statusCode: 400 })
  }
  assertValue('memberRole', role)
  const now = Date.now()
  const info = db
    .prepare(
      `INSERT INTO members (name, username, password_hash, feishu_id, wecom_id, team, is_key_person, max_parallel_projects, role, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`
    )
    .run(name, username, hashPassword(password), feishuId || null, wecomId || null, team || null,
      isKeyPerson ? 1 : 0, maxParallelProjects, role, now, now)
  audit(db, { memberId: by, action: 'member.create', objectType: 'member', objectId: info.lastInsertRowid })
  return getMember(db, Number(info.lastInsertRowid))
}

export function updateMember(db, id, patch, by) {
  const cur = db.prepare('SELECT * FROM members WHERE id = ?').get(id)
  if (!cur) throw Object.assign(new Error('成员不存在'), { statusCode: 404 })
  // S17-7：不能降级最后一名在职系统管理员（防锁死配置台）
  if (patch.role === 'member' && cur.role === 'admin' && cur.status === 'active') assertNotLastAdmin(db)
  // JSON camelCase → SQL snake_case
  const COLMAP = { name: 'name', username: 'username', feishuId: 'feishu_id', wecomId: 'wecom_id', team: 'team',
    isKeyPerson: 'is_key_person', maxParallelProjects: 'max_parallel_projects', role: 'role' }
  const fields = {}
  for (const [jk, col] of Object.entries(COLMAP)) {
    if (!(jk in patch)) continue
    if (jk === 'isKeyPerson') fields[col] = patch[jk] ? 1 : 0
    else if (jk === 'maxParallelProjects') fields[col] = Number(patch[jk]) || 3
    else if (jk === 'role') fields[col] = assertValue('memberRole', patch[jk])
    else fields[col] = patch[jk] || null
  }
  if ('password' in patch && patch.password) fields.password_hash = hashPassword(patch.password)
  if (!Object.keys(fields).length) return getMember(db, id)
  fields.updated_at = Date.now()
  const sets = Object.keys(fields).map((k) => `${k} = @${k}`).join(', ')
  db.prepare(`UPDATE members SET ${sets} WHERE id = @__id`).run({ ...fields, __id: id })
  audit(db, { memberId: by, action: 'member.update', objectType: 'member', objectId: id, detail: { fields: Object.keys(patch) } })
  return getMember(db, id)
}

/**
 * S17-2 离职软删：强制转交其名下未完任务与牵头中的项目，全部覆盖才允许完成。
 * handover: { tasks: [{taskId, toMemberId}], projects: [{projectId, toMemberId}] }
 */
export function offboardMember(db, id, handover = {}, by) {
  const cur = db.prepare(`SELECT * FROM members WHERE id = ?`).get(id)
  if (!cur) throw Object.assign(new Error('成员不存在'), { statusCode: 404 })
  if (cur.status === 'offboarded') return getMember(db, id)
  // S17-7：离职会移除其系统管理员身份，最后一名在职系统管理员不可离职
  if (cur.role === 'admin') assertNotLastAdmin(db)

  const openTasks = db
    .prepare(`SELECT id FROM tasks WHERE responsible_member_id = ? AND status IN ('todo','doing','blocked') AND deleted_at IS NULL`)
    .all(id).map((r) => r.id)
  const leadingProjects = db
    .prepare(`SELECT id FROM projects WHERE lead_member_id = ? AND status = 'active'`)
    .all(id).map((r) => r.id)

  const taskMap = new Map((handover.tasks || []).map((h) => [h.taskId, h.toMemberId]))
  const projMap = new Map((handover.projects || []).map((h) => [h.projectId, h.toMemberId]))
  const missingTasks = openTasks.filter((t) => !taskMap.has(t))
  const missingProjects = leadingProjects.filter((p) => !projMap.has(p))
  if (missingTasks.length || missingProjects.length) {
    throw Object.assign(
      new Error('离职转交未完成：还有未转交的未完任务或牵头项目'),
      { statusCode: 409, missingTasks, missingProjects }
    )
  }
  const now = Date.now()
  const tx = db.transaction(() => {
    for (const [taskId, to] of taskMap) {
      db.prepare('UPDATE tasks SET responsible_member_id = ?, updated_at = ? WHERE id = ?').run(to, now, taskId)
    }
    for (const [projectId, to] of projMap) {
      db.prepare('UPDATE projects SET lead_member_id = ?, updated_at = ? WHERE id = ?').run(to, now, projectId)
    }
    db.prepare(`UPDATE members SET status = 'offboarded', updated_at = ? WHERE id = ?`).run(now, id)
    // 联动：会话与令牌全部失效（必测清单）
    db.prepare('DELETE FROM sessions WHERE member_id = ?').run(id)
    revokeMemberTokens(db, id)
    audit(db, { memberId: by, action: 'member.offboard', objectType: 'member', objectId: id, detail: { taskMap: [...taskMap], projMap: [...projMap] } })
  })
  tx()
  return getMember(db, id)
}
