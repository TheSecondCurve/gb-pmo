import { camelizeRow, camelizeRows } from '../db/index.mjs'
import { assertValue } from './enums.js'
import { audit } from './auth.js'

// PRD v0.18 / K11：项目类型 = 单对象，内嵌任务清单（标题+顺序）。
// v0.5 的「类型/模板两对象 + default_template_id 绑定」已裁撤（migration 0013）；
// 模板只在立项时实例化拷贝的语义不变——编辑类型清单只影响未来立项，历史项目是立项时的实例快照。
// v0.33 / S33：任务项扩展为「标题 + 可选参考链接列表」（SOP/知识库/表单），子表
// project_type_task_refs 镜像实例侧 task_refs；立项时参考随标题拷贝进 task_refs（S23 全套接管）。

const TYPE_COLS = 'pt.id, pt.code, pt.name, pt.description, pt.status, pt.created_at, pt.updated_at'

/** 参考 url 校验（与实例侧 task_refs 同规则；单一真相源，tasks.js 由此 import）。 */
export const HTTP_URL = /^https?:\/\//i

/** 每任务参考上限（防呆：参考是链接型提示，不是文档库）。 */
export const MAX_TASK_REFS = 10

/** 单条参考载荷归一：{title, url, note?} → {title, url, note}；标题必填、url 须 http(s)，否则 400。 */
export function normalizeTypeRef(ref) {
  const r = typeof ref === 'object' && ref !== null ? ref : {}
  const title = String(r.title ?? '').trim()
  const url = String(r.url ?? '').trim()
  if (!title || !url) throw Object.assign(new Error('参考资料 title/url 必填'), { statusCode: 400 })
  if (!HTTP_URL.test(url)) throw Object.assign(new Error('参考资料 url 须为 http(s) 链接'), { statusCode: 400 })
  const note = r.note ? String(r.note).trim() : null
  return { title, url, note }
}

/** 任务清单载荷归一（S1-6/S17-8/S33）：字符串、{title}、{title, refs?} 均可 → [{title, refs}]；
 * 空白标题 400；refs 逐条同实例侧校验，每任务 ≤ MAX_TASK_REFS。 */
export function normalizeTypeTasks(tasks) {
  if (tasks === undefined || tasks === null) return undefined
  if (!Array.isArray(tasks)) throw Object.assign(new Error('tasks 必须是数组'), { statusCode: 400 })
  return tasks.map((t) => {
    const item = typeof t === 'string' ? { title: t } : (t ?? {})
    const title = String(item.title ?? '').trim()
    if (!title) throw Object.assign(new Error('任务标题必填（不可为空白）'), { statusCode: 400 })
    let refs = []
    if (item.refs !== undefined && item.refs !== null) {
      if (!Array.isArray(item.refs)) throw Object.assign(new Error('任务 refs 必须是数组'), { statusCode: 400 })
      if (item.refs.length > MAX_TASK_REFS) {
        throw Object.assign(new Error(`每条任务的参考资料不超过 ${MAX_TASK_REFS} 条`), { statusCode: 400 })
      }
      refs = item.refs.map(normalizeTypeRef)
    }
    return { title, refs }
  })
}

// —— 项目类型 ——

export function listProjectTypes(db) {
  const rows = db.prepare(
    `SELECT ${TYPE_COLS},
       (SELECT COUNT(*) FROM projects p WHERE p.project_type_id = pt.id) AS project_count,
       (SELECT COUNT(*) FROM projects p WHERE p.status = 'active' AND p.project_type_id = pt.id) AS open_project_count
     FROM project_types pt ORDER BY pt.id`
  ).all()
  return rows.map((r) => typeDetail(db, camelizeRow(r)))
}

export function getProjectType(db, id) {
  const row = db.prepare(`SELECT ${TYPE_COLS} FROM project_types pt WHERE pt.id = ?`).get(id)
  return row ? typeDetail(db, camelizeRow(row)) : null
}

export function createProjectType(db, input, by) {
  const { code, name, description } = input
  const taskItems = normalizeTypeTasks(input.tasks) ?? []
  if (!code || !name) throw Object.assign(new Error('code/name 必填'), { statusCode: 400 })
  if (db.prepare('SELECT 1 FROM project_types WHERE code = ?').get(code)) {
    throw Object.assign(new Error(`类型编码已存在: ${code}`), { statusCode: 400 })
  }
  const now = Date.now()
  const tx = db.transaction(() => {
    const info = db.prepare(
      `INSERT INTO project_types (code, name, description, status, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?)`
    ).run(code, name, description || null, now, now)
    insertTasks(db, Number(info.lastInsertRowid), taskItems)
    audit(db, { memberId: by, action: 'projectType.create', objectType: 'project_type', objectId: info.lastInsertRowid, detail: { code, tasks: taskItems.length, taskRefs: taskItems.reduce((s, t) => s + t.refs.length, 0) } })
  })
  tx()
  return getProjectType(db, db.prepare('SELECT id FROM project_types WHERE code = ?').get(code).id)
}

/** tasks 给出即整体替换（任务行+参考行一起换；编辑只影响未来立项，历史项目是立项时的实例拷贝）。 */
export function updateProjectType(db, id, patch, by) {
  const cur = getProjectType(db, id)
  if (!cur) throw Object.assign(new Error('项目类型不存在'), { statusCode: 404 })
  const fields = {}
  if ('name' in patch && patch.name) fields.name = patch.name
  if ('description' in patch) fields.description = patch.description || null
  if ('status' in patch) fields.status = assertValue('projectTypeStatus', patch.status)
  const replacing = 'tasks' in patch
  const finalItems = replacing ? normalizeTypeTasks(patch.tasks) : undefined
  if (!Object.keys(fields).length && !replacing) return getProjectType(db, id)
  fields.updated_at = Date.now()
  const tx = db.transaction(() => {
    const sets = Object.keys(fields).map((k) => `${k} = @${k}`).join(', ')
    db.prepare(`UPDATE project_types SET ${sets} WHERE id = @__id`).run({ ...fields, __id: id })
    if (replacing) {
      clearTypeTasks(db, id)
      insertTasks(db, id, finalItems)
    }
    audit(db, { memberId: by, action: 'projectType.update', objectType: 'project_type', objectId: id, detail: { fields: Object.keys(patch) } })
  })
  tx()
  return getProjectType(db, id)
}

/** 删除类型（S17-13，v0.31）：带守卫的物理删除——仅当无任何项目引用（含已结项/已取消）时允许，
 * 同事务级联清除内嵌任务清单（含任务参考行，S33）并留审计，code 唯一占用随之解除（删后可重建同码）。
 * 「删除=软删」约定在本对象的特例：无引用的类型没有需保留的历史；有引用的移出口径仍是停用。 */
export function deleteProjectType(db, id, by) {
  const cur = getProjectType(db, id)
  if (!cur) throw Object.assign(new Error('项目类型不存在'), { statusCode: 404 })
  const refs = db.prepare('SELECT COUNT(*) AS n FROM projects WHERE project_type_id = ?').get(id).n
  if (refs > 0) {
    throw Object.assign(
      new Error(`该类型有 ${refs} 个项目引用（含已结项/已取消），不能删除；请改用停用（立项不可再选、历史项目不受影响）`),
      { statusCode: 400 },
    )
  }
  const tx = db.transaction(() => {
    clearTypeTasks(db, id)
    db.prepare('DELETE FROM project_types WHERE id = ?').run(id)
    audit(db, { memberId: by, action: 'projectType.delete', objectType: 'project_type', objectId: id, detail: { code: cur.code } })
  })
  tx()
}

// —— 立项解析（createProject 调用）——

/** typeCode 为主入参；templateCode 为兼容别名（v0.18 前类型/模板同码 1:1，按同码类型解析）。 */
export function resolveTypeForCreate(db, { typeCode, templateCode } = {}) {
  const code = typeCode || templateCode
  if (!code) throw Object.assign(new Error('typeCode 必填（项目类型编码）'), { statusCode: 400 })
  const type = db.prepare('SELECT * FROM project_types WHERE code = ?').get(code)
  if (!type) throw Object.assign(new Error(`未知项目类型: ${code}`), { statusCode: 400 })
  if (type.status !== 'active') throw Object.assign(new Error(`项目类型已停用: ${type.name}（${code}）`), { statusCode: 400 })
  return type
}

/** 类型的任务清单（含每任务参考，按顺序）：[{title, refs: [{title, url, note}]}]。 */
export function typeTaskItems(db, typeId) {
  const tasks = db.prepare('SELECT id, title FROM project_type_tasks WHERE type_id = ? ORDER BY sort_order').all(typeId)
  const refStmt = db.prepare('SELECT title, url, note FROM project_type_task_refs WHERE type_task_id = ? ORDER BY sort_order')
  return tasks.map((t) => ({ title: t.title, refs: camelizeRows(refStmt.all(t.id)) }))
}

// —— 内部 ——

/** 清除类型内嵌清单（先参考行后任务行；整体替换与删除类型共用）。 */
function clearTypeTasks(db, typeId) {
  db.prepare(
    'DELETE FROM project_type_task_refs WHERE type_task_id IN (SELECT id FROM project_type_tasks WHERE type_id = ?)'
  ).run(typeId)
  db.prepare('DELETE FROM project_type_tasks WHERE type_id = ?').run(typeId)
}

function insertTasks(db, typeId, items) {
  const refStmt = db.prepare('INSERT INTO project_type_task_refs (type_task_id, title, url, note, sort_order) VALUES (?, ?, ?, ?, ?)')
  items.forEach((item, i) => {
    const info = db.prepare('INSERT INTO project_type_tasks (type_id, title, sort_order) VALUES (?, ?, ?)').run(typeId, item.title, i + 1)
    item.refs.forEach((ref, j) => refStmt.run(Number(info.lastInsertRowid), ref.title, ref.url, ref.note, j + 1))
  })
}

function typeDetail(db, row) {
  return {
    ...row,
    tasks: typeTaskItems(db, row.id),
  }
}
