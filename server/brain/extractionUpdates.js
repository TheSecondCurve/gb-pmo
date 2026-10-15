// S3/K50：项目级抽取候选汇总、确定性对象消歧、批量自动应用与重放幂等。
// LLM 负责给出候选，本模块决定哪些可写；自动执行与人工确认共用 events.js 的 apply 口子。

import { addEvent, applyExtractedEvent } from '../engine/events.js'
import { addTaskRecord } from '../engine/tasks.js'
import { assertValue } from '../engine/enums.js'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const TASK_FIELDS = new Set(['status', 'plan_start_date', 'plan_end_date', 'responsible_member_id'])
const MILESTONE_FIELDS = new Set(['status', 'plan_date'])

function normName(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/[\s#「」『』"'“”]/g, '')
}

function validDate(value) {
  if (!DATE_RE.test(String(value))) return false
  const [y, m, d] = String(value).split('-').map(Number)
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return m >= 1 && m <= 12 && d >= 1 && d <= days
}

function targetRows(db, projectId) {
  const tasks = db.prepare(
    `SELECT id, title AS name, status, plan_start_date, plan_end_date, responsible_member_id, updated_at
     FROM tasks WHERE project_id = ? AND deleted_at IS NULL AND status IN ('todo','doing')`
  ).all(projectId).map((r) => ({ ...r, kind: 'task' }))
  const milestones = db.prepare(
    `SELECT id, name, status, plan_date, actual_date, updated_at FROM milestones WHERE project_id = ? AND status = 'planned'`
  ).all(projectId).map((r) => ({ ...r, kind: 'milestone' }))
  return [...tasks, ...milestones]
}

function fieldFor(targetKind, field) {
  if (targetKind === 'milestone' && field === 'plan_end_date') return 'plan_date'
  if (targetKind === 'task' && field === 'plan_date') return 'plan_end_date'
  return field
}

function valueFor(targetKind, field, value) {
  if (field !== 'status') return value
  if (targetKind === 'milestone' && value === 'done') return 'met'
  if (targetKind === 'task' && value === 'met') return 'done'
  return value
}

function optionFor(target, evt) {
  const targetObject = target.kind
  const targetField = fieldFor(target.kind, evt.targetField)
  return {
    targetObject,
    targetTaskId: target.id,
    targetField,
    targetValue: valueFor(target.kind, targetField, evt.targetValue),
    label: `${target.kind === 'milestone' ? '里程碑' : '任务'}「${target.name}」`,
  }
}

function modelOption(evt) {
  return {
    targetObject: evt.targetObject,
    targetTaskId: evt.targetTaskId,
    targetField: evt.targetField,
    targetValue: evt.targetValue,
    label: `${evt.targetObject === 'milestone' ? '里程碑' : '任务'}「${evt.targetName || `#${evt.targetTaskId}`}」`,
  }
}

function resolveTarget(db, projectId, evt) {
  const targets = targetRows(db, projectId)
  const name = normName(evt.targetName)
  if (!name) return { unique: false, selected: modelOption(evt), candidates: [], named: false }
  let matches = targets.filter((t) => normName(t.name) === name)
  if (!matches.length && name.length >= 2) {
    matches = targets.filter((t) => normName(t.name).includes(name) || name.includes(normName(t.name)))
  }
  const text = String(evt.sourceMsg?.text || '')
  const mentionsMilestone = text.includes('里程碑')
  const mentionsTask = text.includes('任务')
  const explicitKind = mentionsMilestone !== mentionsTask ? (mentionsMilestone ? 'milestone' : 'task') : null
  if (explicitKind) {
    const typed = matches.filter((t) => t.kind === explicitKind)
    if (!typed.length) return { unique: false, selected: modelOption(evt), candidates: [], named: true }
    matches = typed
  }
  if (matches.length === 1) {
    return { unique: true, selected: optionFor(matches[0], evt), candidates: [], named: true }
  }
  if (matches.length > 1) {
    const candidates = matches.map((t) => optionFor(t, evt))
    const selected = candidates.find((c) => c.targetObject === evt.targetObject && Number(c.targetTaskId) === Number(evt.targetTaskId)) || candidates[0]
    return { unique: false, selected, candidates, named: true }
  }
  return { unique: false, selected: modelOption(evt), candidates: [], named: true }
}

function validateOption(db, projectId, option) {
  const isMilestone = option.targetObject === 'milestone'
  const allowed = isMilestone ? MILESTONE_FIELDS : TASK_FIELDS
  if (!allowed.has(option.targetField)) return { ok: false }
  const table = isMilestone ? 'milestones' : 'tasks'
  const deletedGuard = isMilestone ? '' : ' AND deleted_at IS NULL'
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ? AND project_id = ?${deletedGuard}`).get(option.targetTaskId, projectId)
  if (!row) return { ok: false }
  try {
    if (option.targetField === 'status') assertValue(isMilestone ? 'milestoneStatus' : 'taskStatus', String(option.targetValue))
  } catch {
    return { ok: false }
  }
  if (['plan_date', 'plan_start_date', 'plan_end_date'].includes(option.targetField) && !validDate(option.targetValue)) return { ok: false }
  if (option.targetField === 'responsible_member_id') {
    const member = db.prepare(`SELECT 1 AS ok FROM members WHERE id = ? AND status = 'active'`).get(Number(option.targetValue))
    if (!member) return { ok: false }
  }
  const currentValue = row[option.targetField]
  const same = String(currentValue ?? '') === String(option.targetValue ?? '')
  const nextStart = option.targetField === 'plan_start_date' ? option.targetValue : row.plan_start_date
  const nextEnd = option.targetField === 'plan_end_date' ? option.targetValue : row.plan_end_date
  if (!isMilestone && nextStart && nextEnd && nextStart > nextEnd) return { ok: false }
  return { ok: true, row, same, currentValue }
}

function sourceKey(evt, projectId, selected, candidates) {
  const source = evt.sourceMsg
  if (!source?.id) return null
  const objectKey = candidates.length
    ? `name:${normName(evt.targetName)}`
    : `${selected.targetObject}:${selected.targetTaskId}`
  return `im:${evt.sourcePlatform}:${source.id}:${projectId}:${objectKey}:${selected.targetField}`
}

function prepareUpdates(db, projectId, extracted) {
  const byOperation = new Map()
  for (const evt of extracted) {
    if (!evt.sourceMsg?.id) continue // 无源消息 id 的候选在下方单独处理，不进入操作级合并
    const resolved = resolveTarget(db, projectId, evt)
    let selected = resolved.selected
    let candidates = resolved.candidates
    if (candidates.length) {
      const validCandidates = candidates.filter((c) => validateOption(db, projectId, c).ok)
      if (validCandidates.length === 1) {
        selected = validCandidates[0]
        candidates = []
        resolved.unique = true
      } else {
        candidates = validCandidates
        if (!candidates.some((c) => c.targetObject === selected.targetObject && c.targetTaskId === selected.targetTaskId)) selected = candidates[0]
      }
    }
    if (!selected) continue
    const validation = validateOption(db, projectId, selected)
    if (!validation.ok || (candidates.length && candidates.length < 2)) continue
    const operationKey = sourceKey(evt, projectId, selected, candidates)
    const objectKey = candidates.length ? `name:${normName(evt.targetName)}` : `${selected.targetObject}:${selected.targetTaskId}`
    const mergeKey = `${projectId}:${objectKey}:${selected.targetField}`
    const next = {
      ...evt, selected, candidates, resolvedUnique: resolved.unique, validation, operationKey, mergeKey, conflict: false,
    }
    if (!mergeKey) continue
    const previous = byOperation.get(mergeKey)
    if (previous) {
      next.conflict = previous.conflict || (
        previous.sourceMsg?.id === next.sourceMsg?.id && previous.sourceMsg?.ts === next.sourceMsg?.ts
          && String(previous.selected.targetValue) !== String(next.selected.targetValue)
      )
    }
    byOperation.set(mergeKey, next)
  }
  // 无源消息 id 的候选不参与操作级合并，但仍可逐条 pending。
  const withoutKeys = extracted.filter((e) => e.nature === 'suggestion' && !e.sourceMsg?.id).map((evt) => {
    const resolved = resolveTarget(db, projectId, evt)
    const validation = validateOption(db, projectId, resolved.selected)
    return validation.ok ? { ...evt, ...resolved, validation, operationKey: null, conflict: false } : null
  }).filter(Boolean)
  return [...byOperation.values(), ...withoutKeys]
}

function eventPayload(projectId, evt, selected, operationKey, candidates = []) {
  const source = evt.sourceMsg
  return {
    projectId,
    businessTime: source.ts,
    nature: evt.nature,
    eventType: evt.eventType,
    summary: candidates.length ? `${evt.summary}（对象待确认）` : evt.summary,
    rawSnapshot: source.text,
    sourcePlatform: evt.sourcePlatform,
    sourceRef: source.id || null,
    speakerMemberId: source.speakerMemberId ?? null,
    speakerLabel: source.speakerName,
    confidence: evt.confidence ?? null,
    targetObject: selected?.targetObject || evt.targetObject || 'task',
    targetTaskId: selected?.targetTaskId ?? evt.targetTaskId ?? null,
    targetField: selected?.targetField ?? evt.targetField ?? null,
    targetValue: selected?.targetValue !== undefined ? String(selected.targetValue) : (evt.targetValue !== undefined ? String(evt.targetValue) : null),
    targetCandidates: candidates,
    operationKey,
    generatedBy: 'extraction',
  }
}

/**
 * 同一项目本轮候选统一落库。LLM 调用与 IM 推送均在事务外；单条自动应用失败只降级该条 pending。
 * 返回待推送事件，调用方提交后再 pushSuggestion。
 */
export function persistExtractionEvents(db, { projectId, channel, extracted, stats, projectName, batchId }) {
  const ordered = [...extracted].sort((a, b) => a.sourceMsg.ts - b.sourceMsg.ts || (a.sequence ?? 0) - (b.sequence ?? 0))
  const updates = prepareUpdates(db, projectId, ordered.filter((e) => e.nature === 'suggestion'))
  const records = ordered.filter((e) => e.nature !== 'suggestion')
  const items = [
    ...records.map((evt) => ({ kind: 'record', evt, ts: evt.sourceMsg.ts })),
    ...updates.map((evt) => ({ kind: 'update', evt, ts: evt.sourceMsg.ts })),
  ].sort((a, b) => a.ts - b.ts || (a.evt.sequence ?? 0) - (b.evt.sequence ?? 0))
  const pending = []

  const persistAll = db.transaction(() => {
    for (const item of items) {
      const evt = item.evt
      const source = evt.sourceMsg
      if (item.kind === 'record') {
        addEvent(db, eventPayload(projectId, { ...evt, sourcePlatform: channel.platform }, null, null))
        stats.events += 1
        if (evt.eventType === 'progress') {
          stats.progressEvents.push({ projectId, projectName, summary: evt.summary })
        }
        if (evt.targetTaskId) {
          try {
            addTaskRecord(db, { taskId: evt.targetTaskId, content: evt.summary }, source.speakerMemberId)
            stats.taskRecords += 1
          } catch { /* 终态只读/任务已删：保留事件，跳过任务时间线 */ }
        }
        continue
      }

      if (evt.operationKey && db.prepare('SELECT 1 AS ok FROM project_events WHERE operation_key = ?').get(evt.operationKey)) {
        stats.duplicates += 1
        continue
      }
      if (!evt.candidates.length && evt.validation.same) {
        stats.duplicates += 1
        continue
      }
      const selected = evt.selected
      const attributed = evt.sourceAttributed && Boolean(source.id)
      const freshEnough = !(evt.validation.row?.updated_at > source.ts)
      const project = db.prepare('SELECT status FROM projects WHERE id = ?').get(projectId)
      const auto = evt.resolvedUnique && !evt.candidates.length && !evt.conflict && attributed && freshEnough
        && project?.status === 'active' && Number(evt.confidence) >= 0.85 && Boolean(evt.operationKey)
      const payload = eventPayload(projectId, { ...evt, sourcePlatform: channel.platform }, selected, evt.operationKey, evt.candidates)
      let created
      let applied = false
      if (auto) {
        const applyOne = db.transaction(() => {
          created = addEvent(db, payload)
          applyExtractedEvent(db, created.id, { batchId })
        })
        try {
          applyOne()
          applied = true
        } catch {
          created = null // 单条回滚后改落 pending，不阻断项目内其他候选
        }
      }
      if (!applied) created = addEvent(db, payload)
      if (applied) {
        stats.events += 1
        stats.autoApplied += 1
      } else {
        stats.suggestions += 1
        pending.push(created)
      }
    }
  })
  persistAll()
  return pending
}
