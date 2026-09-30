import { camelizeRow, camelizeRows } from '../db/index.mjs'
import { assertValue } from './enums.js'
import { audit } from './auth.js'

// PRD v0.5 / S17-8：项目类型与任务模板是两个对象——一类型绑定一个默认模板（多类型可共用），
// 立项选类型即套用其模板；模板只在立项时实例化拷贝，后续编辑不影响历史项目。
// v0.6：模板 = 纯任务清单（无阶段层、无预设依赖，任务只有标题与顺序）。

const TYPE_COLS = 'pt.id, pt.code, pt.name, pt.description, pt.default_template_id, pt.status, pt.created_at, pt.updated_at'
const TPL_COLS = 't.id, t.code, t.name, t.description, t.created_at, t.updated_at'

// —— 项目类型 ——

export function listProjectTypes(db) {
  const rows = db.prepare(
    `SELECT ${TYPE_COLS}, tpl.name AS default_template_name,
       (SELECT COUNT(*) FROM projects p WHERE p.project_type_id = pt.id) AS project_count,
       (SELECT COUNT(*) FROM projects p WHERE p.status IN ('planning','active','paused') AND p.project_type_id = pt.id) AS open_project_count
     FROM project_types pt LEFT JOIN project_templates tpl ON tpl.id = pt.default_template_id
     ORDER BY pt.id`
  ).all()
  return camelizeRows(rows)
}

export function getProjectType(db, id) {
  const row = db.prepare(`SELECT ${TYPE_COLS} FROM project_types pt WHERE pt.id = ?`).get(id)
  return row ? camelizeRow(row) : null
}

export function createProjectType(db, input, by) {
  const { code, name, description, defaultTemplateId } = input
  if (!code || !name) throw Object.assign(new Error('code/name 必填'), { statusCode: 400 })
  if (!defaultTemplateId) throw Object.assign(new Error('必须绑定一个默认任务模板'), { statusCode: 400 })
  assertTemplateExists(db, defaultTemplateId)
  if (db.prepare('SELECT 1 FROM project_types WHERE code = ?').get(code)) {
    throw Object.assign(new Error(`类型编码已存在: ${code}`), { statusCode: 400 })
  }
  const now = Date.now()
  const info = db.prepare(
    `INSERT INTO project_types (code, name, description, default_template_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?)`
  ).run(code, name, description || null, defaultTemplateId, now, now)
  audit(db, { memberId: by, action: 'projectType.create', objectType: 'project_type', objectId: info.lastInsertRowid, detail: { code } })
  return getProjectTypeDetail(db, Number(info.lastInsertRowid))
}

export function updateProjectType(db, id, patch, by) {
  const cur = getProjectType(db, id)
  if (!cur) throw Object.assign(new Error('项目类型不存在'), { statusCode: 404 })
  const fields = {}
  if ('name' in patch && patch.name) fields.name = patch.name
  if ('description' in patch) fields.description = patch.description || null
  if ('defaultTemplateId' in patch) {
    assertTemplateExists(db, patch.defaultTemplateId)
    fields.default_template_id = patch.defaultTemplateId
  }
  if ('status' in patch) fields.status = assertValue('projectTypeStatus', patch.status)
  if (!Object.keys(fields).length) return getProjectTypeDetail(db, id)
  fields.updated_at = Date.now()
  const sets = Object.keys(fields).map((k) => `${k} = @${k}`).join(', ')
  db.prepare(`UPDATE project_types SET ${sets} WHERE id = @__id`).run({ ...fields, __id: id })
  audit(db, { memberId: by, action: 'projectType.update', objectType: 'project_type', objectId: id, detail: { fields: Object.keys(patch) } })
  return getProjectTypeDetail(db, id)
}

// —— 任务模板 ——

export function listTemplates(db) {
  const rows = db.prepare(
    `SELECT ${TPL_COLS},
       (SELECT COUNT(*) FROM project_types pt WHERE pt.default_template_id = t.id) AS type_count,
       (SELECT COUNT(*) FROM projects p WHERE p.template_code = t.code) AS project_count
     FROM project_templates t ORDER BY t.id`
  ).all()
  return rows.map((r) => templateDetail(db, camelizeRow(r)))
}

export function getTemplate(db, id) {
  const row = db.prepare(
    `SELECT ${TPL_COLS},
       (SELECT COUNT(*) FROM project_types pt WHERE pt.default_template_id = t.id) AS type_count,
       (SELECT COUNT(*) FROM projects p WHERE p.template_code = t.code) AS project_count
     FROM project_templates t WHERE t.id = ?`
  ).get(id)
  if (!row) throw Object.assign(new Error('任务模板不存在'), { statusCode: 404 })
  return templateDetail(db, camelizeRow(row))
}

export function createTemplate(db, input, by) {
  const { code, name, description, tasks = [] } = input
  if (!code || !name) throw Object.assign(new Error('code/name 必填'), { statusCode: 400 })
  if (db.prepare('SELECT 1 FROM project_templates WHERE code = ?').get(code)) {
    throw Object.assign(new Error(`模板编码已存在: ${code}`), { statusCode: 400 })
  }
  validateTasks(tasks)
  const now = Date.now()
  const tx = db.transaction(() => {
    const info = db.prepare(
      'INSERT INTO project_templates (code, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run(code, name, description || null, now, now)
    insertTasks(db, Number(info.lastInsertRowid), tasks)
    audit(db, { memberId: by, action: 'template.create', objectType: 'template', objectId: info.lastInsertRowid, detail: { code } })
  })
  tx()
  return getTemplate(db, db.prepare('SELECT id FROM project_templates WHERE code = ?').get(code).id)
}

/** tasks 给出即整体替换（编辑只影响未来立项，历史项目是立项时的实例拷贝）。 */
export function updateTemplate(db, id, patch, by) {
  const cur = db.prepare('SELECT * FROM project_templates WHERE id = ?').get(id)
  if (!cur) throw Object.assign(new Error('任务模板不存在'), { statusCode: 404 })
  const fields = {}
  if ('name' in patch && patch.name) fields.name = patch.name
  if ('description' in patch) fields.description = patch.description || null
  const replacing = 'tasks' in patch
  if (!Object.keys(fields).length && !replacing) return getTemplate(db, id)
  const finalTasks = 'tasks' in patch ? patch.tasks ?? [] : getCurrentTasks(db, id)
  if (replacing) validateTasks(finalTasks)
  fields.updated_at = Date.now()
  const tx = db.transaction(() => {
    const sets = Object.keys(fields).map((k) => `${k} = @${k}`).join(', ')
    db.prepare(`UPDATE project_templates SET ${sets} WHERE id = @__id`).run({ ...fields, __id: id })
    if (replacing) {
      db.prepare('DELETE FROM template_tasks WHERE template_id = ?').run(id)
      insertTasks(db, id, finalTasks)
    }
    audit(db, { memberId: by, action: 'template.update', objectType: 'template', objectId: id, detail: { fields: Object.keys(patch) } })
  })
  tx()
  return getTemplate(db, id)
}

/** 仅当无类型绑定、无项目引用时可物理删（防引用悬空）。 */
export function deleteTemplate(db, id, by) {
  const cur = db.prepare('SELECT * FROM project_templates WHERE id = ?').get(id)
  if (!cur) throw Object.assign(new Error('任务模板不存在'), { statusCode: 404 })
  const boundTypes = db.prepare('SELECT COUNT(*) AS n FROM project_types WHERE default_template_id = ?').get(id).n
  if (boundTypes > 0) {
    throw Object.assign(new Error(`模板被 ${boundTypes} 个项目类型绑定，先解绑或停用相关类型`), { statusCode: 409 })
  }
  const usedBy = db.prepare('SELECT COUNT(*) AS n FROM projects WHERE template_code = ?').get(cur.code).n
  if (usedBy > 0) {
    throw Object.assign(new Error(`模板已被 ${usedBy} 个项目使用（历史快照），不可删除`), { statusCode: 409 })
  }
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM template_stages WHERE template_id = ?').run(id)
    db.prepare('DELETE FROM template_tasks WHERE template_id = ?').run(id)
    db.prepare('DELETE FROM project_templates WHERE id = ?').run(id)
    audit(db, { memberId: by, action: 'template.delete', objectType: 'template', objectId: id, detail: { code: cur.code } })
  })
  tx()
  return { ok: true }
}

// —— 立项解析（createProject 调用）——

/** typeCode 优先（S1-5）；兼容 templateCode 直给（Agent/旧调用，类型留空）。 */
export function resolveTemplateForCreate(db, { typeCode, templateCode } = {}) {
  if (typeCode) {
    const type = db.prepare('SELECT * FROM project_types WHERE code = ?').get(typeCode)
    if (!type) throw Object.assign(new Error(`未知项目类型: ${typeCode}`), { statusCode: 400 })
    if (type.status !== 'active') throw Object.assign(new Error(`项目类型已停用: ${type.name}（${typeCode}）`), { statusCode: 400 })
    const template = db.prepare('SELECT * FROM project_templates WHERE id = ?').get(type.default_template_id)
    if (!template) throw Object.assign(new Error(`类型「${type.name}」绑定的模板不存在，请在配置台修正`), { statusCode: 400 })
    return { type, template }
  }
  const template = db.prepare('SELECT * FROM project_templates WHERE code = ?').get(templateCode || 'custom')
  if (!template) throw Object.assign(new Error(`未知模板: ${templateCode}`), { statusCode: 400 })
  return { type: null, template }
}

// —— 内部 ——

function assertTemplateExists(db, id) {
  if (!db.prepare('SELECT 1 FROM project_templates WHERE id = ?').get(id)) {
    throw Object.assign(new Error(`任务模板不存在: #${id}`), { statusCode: 400 })
  }
}

function validateTasks(tasks) {
  if (!Array.isArray(tasks)) throw Object.assign(new Error('tasks 必须是数组'), { statusCode: 400 })
  for (const t of tasks) {
    if (!t?.title || !String(t.title).trim()) throw Object.assign(new Error('任务标题必填'), { statusCode: 400 })
  }
}

function insertTasks(db, templateId, tasks) {
  tasks.forEach((t, i) => {
    db.prepare('INSERT INTO template_tasks (template_id, title, sort_order) VALUES (?, ?, ?)')
      .run(templateId, String(t.title).trim(), i + 1)
  })
}

function getCurrentTasks(db, templateId) {
  return camelizeRows(
    db.prepare('SELECT title FROM template_tasks WHERE template_id = ? ORDER BY sort_order').all(templateId)
  )
}

function templateDetail(db, row) {
  return {
    ...row,
    tasks: camelizeRows(
      db.prepare('SELECT title FROM template_tasks WHERE template_id = ? ORDER BY sort_order').all(row.id)
    ),
  }
}

function getProjectTypeDetail(db, id) {
  const row = db.prepare(
    `SELECT ${TYPE_COLS}, tpl.name AS default_template_name, tpl.code AS default_template_code,
       (SELECT COUNT(*) FROM projects p WHERE p.project_type_id = pt.id) AS project_count,
       (SELECT COUNT(*) FROM projects p WHERE p.status IN ('planning','active','paused') AND p.project_type_id = pt.id) AS open_project_count
     FROM project_types pt LEFT JOIN project_templates tpl ON tpl.id = pt.default_template_id
     WHERE pt.id = ?`
  ).get(id)
  return camelizeRow(row)
}
