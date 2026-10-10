import { camelizeRow, camelizeRows } from '../db/index.mjs'
import { today } from '../db/time.js'
import { assertValue } from './enums.js'

const EVENT_COLS = `id, project_id, business_time, created_at, nature, event_type, summary, raw_snapshot,
  source_platform, source_ref, speaker_member_id, speaker_label, confidence, status,
  target_object, target_task_id, target_field, target_value, decided_by, decided_at, generated_by, pushed_to`

/**
 * 追加项目事件（讨论面 append-only：只插入；确认流转只改 status/decided_* 决策字段，不改业务内容）。
 * LLM 信任边界：nature=suggestion 的写入一律 status=pending 等人确认；record 默认 effective。
 */
export function addEvent(db, evt) {
  const {
    projectId, businessTime = Date.now(), nature = 'record', eventType, summary,
    rawSnapshot = null, sourcePlatform = 'web', sourceRef = null,
    speakerMemberId = null, speakerLabel = null, confidence = null,
    targetObject = 'task', targetTaskId = null, targetField = null, targetValue = null,
    generatedBy = 'system',
  } = evt
  if (!projectId || !summary || !eventType) {
    throw Object.assign(new Error('projectId/summary/eventType 必填'), { statusCode: 400 })
  }
  assertValue('eventNature', nature)
  assertValue('eventType', eventType)
  const status = evt.status || (nature === 'suggestion' ? 'pending' : 'effective')
  assertValue('eventStatus', status)
  const info = db
    .prepare(
      `INSERT INTO project_events (project_id, business_time, created_at, nature, event_type, summary, raw_snapshot,
         source_platform, source_ref, speaker_member_id, speaker_label, confidence, status,
         target_object, target_task_id, target_field, target_value, generated_by, pushed_to)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]')`
    )
    .run(projectId, businessTime, Date.now(), nature, eventType, summary, rawSnapshot,
      sourcePlatform, sourceRef, speakerMemberId, speakerLabel, confidence, status,
      targetObject, targetTaskId, targetField, targetValue, generatedBy)
  return getEvent(db, Number(info.lastInsertRowid))
}

export function getEvent(db, id) {
  return camelizeRow(db.prepare(`SELECT ${EVENT_COLS} FROM project_events WHERE id = ?`).get(id))
}

export function listEvents(db, { projectId, status, limit = 200 } = {}) {
  const conds = []
  const params = []
  if (projectId) { conds.push('project_id = ?'); params.push(projectId) }
  if (status) { conds.push('status = ?'); params.push(status) }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
  return camelizeRows(
    db.prepare(`SELECT ${EVENT_COLS} FROM project_events ${where} ORDER BY business_time DESC, id DESC LIMIT ?`).all(...params, limit)
  )
}

/** 某人待确认的建议队列：指向其名下任务，或其牵头项目（推送目标）。 */
export function pendingSuggestionsFor(db, memberId) {
  return camelizeRows(
    db.prepare(
      `SELECT e.* FROM project_events e
       LEFT JOIN tasks t ON t.id = e.target_task_id
       LEFT JOIN projects p ON p.id = e.project_id
       WHERE e.status = 'pending' AND e.nature = 'suggestion'
         AND (t.responsible_member_id = ? OR p.lead_member_id = ?)
       ORDER BY e.created_at ASC`
    ).all(memberId, memberId).map((r) => camelizeRow(r))
  )
}

/** 记录推送对象（谁已被通知过这条建议）。 */
export function markPushedTo(db, eventId, memberIds) {
  const cur = JSON.parse(db.prepare('SELECT pushed_to FROM project_events WHERE id = ?').get(eventId)?.pushed_to || '[]')
  const next = [...new Set([...cur, ...memberIds])]
  db.prepare('UPDATE project_events SET pushed_to = ? WHERE id = ?').run(JSON.stringify(next), eventId)
}

/**
 * 确认建议并应用目标变更（S4-3 / S4-4 / S15-2）：人确认后才真正改任务/里程碑，事件留痕。
 */
export function confirmEvent(db, id, by) {
  const e = db.prepare('SELECT * FROM project_events WHERE id = ?').get(id)
  if (!e) throw Object.assign(new Error('事件不存在'), { statusCode: 404 })
  if (e.status !== 'pending') throw Object.assign(new Error(`事件状态为 ${e.status}，仅待确认事件可确认`), { statusCode: 409 })
  // S29 双保险：终态项目（已结项/已取消）的建议不可再生效（结束时已批量过期，此处挡新挂建议）
  const proj = db.prepare('SELECT status FROM projects WHERE id = ?').get(e.project_id)
  if (proj && (proj.status === 'closed' || proj.status === 'cancelled')) {
    throw Object.assign(new Error('项目已结项/取消，建议不可确认（S29 终态只读）'), { statusCode: 409 })
  }

  const apply = db.transaction(() => {
    if (e.nature === 'suggestion' && e.target_field && e.target_value !== null) {
      if (e.target_object === 'milestone') {
        applyMilestonePatch(db, e)
      } else {
        applyTaskPatch(db, e)
      }
    }
    db.prepare('UPDATE project_events SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?')
      .run('effective', by, Date.now(), id)
  })
  apply()
  return getEvent(db, id)
}

export function rejectEvent(db, id, by) {
  const e = db.prepare('SELECT id, status FROM project_events WHERE id = ?').get(id)
  if (!e) throw Object.assign(new Error('事件不存在'), { statusCode: 404 })
  if (e.status !== 'pending') throw Object.assign(new Error(`事件状态为 ${e.status}，仅待确认事件可驳回`), { statusCode: 409 })
  db.prepare('UPDATE project_events SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?')
    .run('rejected', by, Date.now(), id)
  return getEvent(db, id)
}

/** 超时未处理的建议标记过期（S16-3 配套）。 */
export function expireStaleSuggestions(db, timeoutHours) {
  const cutoff = Date.now() - timeoutHours * 3600 * 1000
  const info = db
    .prepare(`UPDATE project_events SET status = 'expired' WHERE status = 'pending' AND nature = 'suggestion' AND created_at < ?`)
    .run(cutoff)
  return info.changes
}

// —— S4-7（v0.46/K25）一键批量处理：逐条走 confirmEvent/rejectEvent 同一口子，单条失败不阻塞其余 ——

function normIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw Object.assign(new Error('ids 必填且须为非空数组'), { statusCode: 400 })
  }
  if (ids.length > 100) throw Object.assign(new Error('ids 至多 100 条'), { statusCode: 400 })
  return ids.map((id) => {
    const n = Number(id)
    if (!Number.isInteger(n) || n <= 0) throw Object.assign(new Error(`非法事件 id: ${id}`), { statusCode: 400 })
    return n
  })
}

function batchDecide(ids, by, fn, noun) {
  const done = []
  const failed = []
  for (const id of normIds(ids)) {
    try {
      fn(id, by)
      done.push(id)
    } catch (e) {
      failed.push({ id, message: e.message })
    }
  }
  return { [noun]: done, failed }
}

/** 批量确认生效（web 待确认队列「全部生效」）：聚合返回，单条 409/404 计入 failed 不中断。 */
export function confirmEvents(db, ids, by) {
  return batchDecide(ids, by, (id) => confirmEvent(db, id, by), 'confirmed')
}

/** 批量驳回（「全部驳回」）：同上聚合语义。 */
export function rejectEvents(db, ids, by) {
  return batchDecide(ids, by, (id) => rejectEvent(db, id, by), 'rejected')
}

function applyTaskPatch(db, e) {
  // S36：目标任务已软删的建议不可生效（事务回滚，事件保持 pending；不复活任务面）
  const alive = db.prepare('SELECT 1 AS ok FROM tasks WHERE id = ? AND deleted_at IS NULL').get(e.target_task_id)
  if (!alive) throw Object.assign(new Error('任务已删除，建议不可生效'), { statusCode: 409 })
  const field = e.target_field
  const value = e.target_value
  if (field === 'status') {
    assertValue('taskStatus', value)
    db.prepare('UPDATE tasks SET status = ?, actual_end_date = ?, updated_at = ? WHERE id = ?')
      .run(value, value === 'done' ? today() : null, Date.now(), e.target_task_id)
    // S59（v0.65，K43）：建议确认置 done 同样落进展（与状态修改同事务原子，generatedBy=extraction）
    if (value === 'done') {
      const title = db.prepare('SELECT title FROM tasks WHERE id = ?').get(e.target_task_id)?.title || `任务#${e.target_task_id}`
      addEvent(db, {
        projectId: e.project_id, eventType: 'progress', nature: 'record',
        sourcePlatform: e.source_platform || 'web', generatedBy: 'extraction',
        summary: `✅ 完成任务「${title}」`, speakerMemberId: e.speaker_member_id ?? null,
      })
    }
  } else if (field === 'plan_end_date' || field === 'plan_start_date') {
    db.prepare(`UPDATE tasks SET ${field} = ?, updated_at = ? WHERE id = ?`).run(value, Date.now(), e.target_task_id)
  } else if (field === 'responsible_member_id') {
    db.prepare('UPDATE tasks SET responsible_member_id = ?, updated_at = ? WHERE id = ?').run(Number(value), Date.now(), e.target_task_id)
  } else {
    throw Object.assign(new Error(`不支持的建议目标字段: ${field}`), { statusCode: 400 })
  }
}

function applyMilestonePatch(db, e) {
  // S35：扩展状态字段（达成/延误/取消）；met 落实际日期=当天（北京日），镜像任务 done→actual_end_date 口径
  if (e.target_field === 'plan_date') {
    db.prepare('UPDATE milestones SET plan_date = ?, updated_at = ? WHERE id = ?').run(e.target_value, Date.now(), e.target_task_id)
  } else if (e.target_field === 'status') {
    assertValue('milestoneStatus', e.target_value)
    db.prepare('UPDATE milestones SET status = ?, actual_date = ?, updated_at = ? WHERE id = ?')
      .run(e.target_value, e.target_value === 'met' ? today() : null, Date.now(), e.target_task_id)
  } else {
    throw Object.assign(new Error(`不支持的里程碑建议字段: ${e.target_field}`), { statusCode: 400 })
  }
}
