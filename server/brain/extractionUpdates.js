// S3/K50：项目级抽取候选汇总、确定性对象消歧、批量自动应用与重放幂等。
// LLM 负责给出候选，本模块决定哪些可写；自动执行与人工确认共用 events.js 的 apply 口子。
// S69-9（v0.91，K64 修订）：record 分流识别 day_status 打卡候选——唯一命中+发言人映射+高置信+归因
// 明确时自动写当日打卡记录（复用 setDayStatus 同一写入口），否则降级普通 record 归档。

import { addEvent, applyExtractedEvent } from '../engine/events.js'
import { addTaskRecord } from '../engine/tasks.js'
import { assertValue } from '../engine/enums.js'
import { setDayStatus } from '../engine/dailyBoard.js'
import { today } from '../db/time.js'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const TASK_FIELDS = new Set(['status', 'plan_start_date', 'plan_end_date', 'responsible_member_id'])
const MILESTONE_FIELDS = new Set(['status', 'plan_date'])
// K64 修订：常态任务无终态（S69）——状态/计划日期字段不经抽取建议通道（打卡走 day_status 分流）
const ROUTINE_FORBIDDEN_FIELDS = new Set(['status', 'plan_start_date', 'plan_end_date'])

function normName(value) {
  // 剥离集含 〔〕：清单标记会随标题被模型回显进 targetName（GLM 实测），消歧须与裸标题可比
  return String(value || '').normalize('NFKC').toLowerCase().replace(/[\s#「」『〕〔"'“”]/g, '')
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
  // S69-9 硬守卫：常态任务的状态/计划日期字段建议一律拒绝（K64 修订：打卡语义走 day_status 分流，
  // 状态变更对无终态的常态任务是污染——不 pending 不生效，直接不出候选）
  if (!isMilestone && row.kind === 'routine' && ROUTINE_FORBIDDEN_FIELDS.has(option.targetField)) return { ok: false }
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
 * S69-9（v0.91，K64 修订）打卡候选自动生效：资格闸门全过 → 复用 setDayStatus 写当日打卡记录
 * （day=源消息北京日、操作人=发言成员、origin=bot、事件/审计同构）；幂等锚 operation_key。
 * 返回 'applied'（已生效）/ 'skipped'（同消息重放，不复活）/ 'downgrade'（资格不足或引擎拒绝，
 * 调用方降级普通 record 归档）。闸门对齐 K50 自动生效纪律：唯一命中、发言人已映射、归因明确、
 * confidence≥0.85、项目 active；已有当日记录（人工/机器人先打过）不覆盖——降级归档留痕。
 */
function applyDayStatusCandidate(db, { projectId, projectName, channel, evt, source, stats }) {
  const resolved = resolveTarget(db, projectId, evt)
  const selected = resolved.selected
  if (!resolved.unique || resolved.candidates.length || !selected?.targetTaskId || selected.targetObject === 'milestone') return 'downgrade'
  if (selected.targetField !== 'day_status') return 'downgrade'
  const task = db.prepare(`SELECT kind FROM tasks WHERE id = ? AND project_id = ? AND deleted_at IS NULL`).get(selected.targetTaskId, projectId)
  if (!task || task.kind !== 'routine') return 'downgrade' // 打卡仅常态任务（交付项目任务无 day 语义）
  const status = String(selected.targetValue)
  if (status !== 'done' && status !== 'skip') return 'downgrade'
  const day = today(source.ts)
  const operationKey = `im:${channel.platform}:${source.id}:${projectId}:task:${selected.targetTaskId}:day_status:${day}`
  if (db.prepare('SELECT 1 AS ok FROM project_events WHERE operation_key = ?').get(operationKey)) {
    stats.duplicates += 1 // 同消息重放（重试/游标重置/人工重置后）不复活，K50 ④ 同哲学
    return 'skipped'
  }
  if (db.prepare('SELECT 1 AS ok FROM task_day_records WHERE task_id = ? AND day = ?').get(selected.targetTaskId, day)) {
    return 'downgrade' // 当日已有记录（人工/其他消息先打过）：不覆盖既有事实，消息照归档
  }
  const project = db.prepare('SELECT status FROM projects WHERE id = ?').get(projectId)
  const attributed = evt.sourceAttributed && Boolean(source.id)
  const qualifies = Boolean(source.speakerMemberId) && attributed && Number(evt.confidence) >= 0.85 && project?.status === 'active'
  if (!qualifies) return 'downgrade'
  try {
    const out = setDayStatus(db, { projectId, taskId: selected.targetTaskId, day, status }, source.speakerMemberId, {
      origin: 'bot', sourcePlatform: channel.platform, sourceRef: source.id, operationKey, businessTime: source.ts,
    })
    if (out.eventId) {
      stats.events += 1
      const ev = db.prepare('SELECT summary FROM project_events WHERE id = ?').get(out.eventId)
      stats.progressEvents.push({ projectId, projectName, summary: ev?.summary || evt.summary })
    }
    return 'applied'
  } catch {
    return 'downgrade' // 不适用日/未来日/终态只读等引擎拒绝（400/409）：降级归档，不炸本轮
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
        // S69-9：打卡候选先走自动生效闸门（applied/skipped 即终结；downgrade 落下方普通 record 归档）
        if (evt.targetField === 'day_status' && evt.targetTaskId) {
          const applied = applyDayStatusCandidate(db, { projectId, projectName, channel, evt, source, stats })
          if (applied !== 'downgrade') continue
        }
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
