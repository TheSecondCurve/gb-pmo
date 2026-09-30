// 大脑·梳理（S15 by 项目 / S16 by 员工）+ 结项复盘摘要（S8-2）。
// LLM 出叙事与建议；建议一律走建议型事件等人确认（S15-2）。LLM 未配置时确定性降级。

import { camelizeRows, camelizeRow } from '../db/index.mjs'
import { today } from '../db/time.js'
import { getSetting } from '../engine/settings.js'
import { addEvent, markPushedTo, pendingSuggestionsFor } from '../engine/events.js'
import { taskRefMap, formatTaskRefs } from '../engine/tasks.js'
import { getLlm, parseJsonLoose } from './llm.js'
import { notifyMember } from './push.js'

const DAY = 86400000

/** S15 项目梳理：任务面 + 讨论面双来源汇总，每条结论带依据引用。 */
export async function projectDigest(db, projectId, { llm: llmOverride, windowDays = 7 } = {}) {
  const llm = getLlm(db, llmOverride)
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId)
  if (!project) throw Object.assign(new Error('项目不存在'), { statusCode: 404 })
  const th = getSetting(db, 'thresholds')

  const tasks = camelizeRows(
    db.prepare(
      `SELECT t.id, t.title, t.status, t.plan_start_date, t.plan_end_date, m.name AS responsible_name
       FROM tasks t LEFT JOIN members m ON m.id = t.responsible_member_id
       WHERE t.project_id = ? AND t.status IN ('todo','doing') ORDER BY t.plan_end_date`
    ).all(projectId)
  )
  const overdue = tasks.filter((t) => t.planEndDate && t.planEndDate < today())
  const unassigned = tasks.filter((t) => !t.responsibleMemberId && t.planStartDate)
  const events = camelizeRows(
    db.prepare(
      `SELECT id, event_type, summary, business_time, status FROM project_events
       WHERE project_id = ? AND business_time >= ? ORDER BY business_time DESC LIMIT 50`
    ).all(projectId, Date.now() - windowDays * DAY)
  )
  const lastEventAt = events[0]?.businessTime || null
  const taskChangedRecently = db
    .prepare('SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND updated_at >= ?').get(projectId, Date.now() - windowDays * DAY).n
  const silent = !lastEventAt && taskChangedRecently === 0 || (lastEventAt && lastEventAt < Date.now() - th.silentDays * DAY && taskChangedRecently === 0)

  const taskPlane = tasks.map((t) => `#${t.id} ${t.title} [${t.status}]${t.planEndDate ? ` 截止${t.planEndDate}${t.planEndDate < today() ? '（已逾期）' : ''}` : ''}${t.responsibleName ? ` 负责:${t.responsibleName}` : '（未指派）'}`).join('\n') || '（无未完任务）'
  const discussionPlane = events.map((e) => `[${today(e.businessTime)}] ${e.summary}（事件#${e.id}）`).join('\n') || '（窗口期内无事件）'

  let narrative
  const suggestions = []
  if (llm) {
    const out = await llm.complete(
      [
        {
          role: 'system',
          content: `你是企业项目大脑，为牵头人生成项目梳理。输出 JSON：
{"narrative":"进展综述（3-5句，每句结论标注依据，如（任务#3）（事件#12））","suggestions":[{"summary":"排期/风险建议一句","targetTaskId":<未完任务id>,"targetField":"plan_end_date|plan_start_date","targetValue":"YYYY-MM-DD"}]}
建议只针对确有依据的排期调整；没有就给空数组。只输出 JSON。`,
        },
        {
          role: 'user',
          content: `项目：${project.name}${project.client_name ? `（客户 ${project.client_name}）` : ''}，优先级 ${project.priority}，状态 ${project.status}\n任务面：\n${taskPlane}\n\n讨论面（近${windowDays}天）：\n${discussionPlane}\n\n逾期任务：${overdue.length}，未指派：${unassigned.length}${silent ? '\n注意：本项目近窗口无事件且无任务变动（项目沉默）。' : ''}`,
        },
      ],
      { json: true }
    )
    const parsed = parseJsonLoose(out)
    if (parsed?.narrative) narrative = parsed.narrative
    if (Array.isArray(parsed?.suggestions)) suggestions.push(...parsed.suggestions)
  }
  narrative ||= `任务面：未完 ${tasks.length} 项（逾期 ${overdue.length}、未指派 ${unassigned.length}）。讨论面：近 ${windowDays} 天 ${events.length} 条事件。${silent ? '项目沉默：近窗口无事件且无任务变动。' : ''}`

  const createdSuggestions = []
  const validTasks = new Set(tasks.map((t) => t.id))
  for (const s of suggestions) {
    if (!s?.summary || !validTasks.has(Number(s.targetTaskId)) || !s.targetField || !s.targetValue) continue
    const evt = addEvent(db, {
      projectId, nature: 'suggestion', eventType: 'suggestion', summary: `[梳理建议] ${s.summary}`,
      sourcePlatform: 'brain', generatedBy: 'digest', confidence: 0.5,
      targetTaskId: Number(s.targetTaskId), targetField: s.targetField, targetValue: String(s.targetValue),
    })
    createdSuggestions.push(evt)
  }
  const lead = db.prepare('SELECT * FROM members WHERE id = ?').get(project.lead_member_id)
  const title = `项目梳理：${project.name}${silent ? '（项目沉默）' : ''}`
  const body = `${silent ? '⚠ 项目沉默：近窗口无事件且无任务变动。\n' : ''}${narrative}\n\n任务面：\n${taskPlane}\n\n建议 ${createdSuggestions.length} 条（待确认生效）`
  if (lead) {
    notifyMember(db, camelizeRow(lead), { pushType: 'digest', title, body, projectId })
    for (const evt of createdSuggestions) markPushedTo(db, evt.id, [lead.id])
  }
  return { projectId, title, narrative, silent, taskCount: tasks.length, overdueCount: overdue.length, unassignedCount: unassigned.length, eventCount: events.length, suggestions: createdSuggestions }
}

/** S16 员工梳理：跨项目任务 + 被依赖 + 排期冲突 + 超时待确认置顶。 */
export async function personDigest(db, memberId, { llm: llmOverride } = {}) {
  const llm = getLlm(db, llmOverride)
  const member = db.prepare('SELECT * FROM members WHERE id = ?').get(memberId)
  if (!member) throw Object.assign(new Error('成员不存在'), { statusCode: 404 })
  const th = getSetting(db, 'thresholds')

  const tasks = camelizeRows(
    db.prepare(
      `SELECT t.id, t.title, t.status, t.plan_start_date, t.plan_end_date, p.name AS project_name, p.id AS project_id
       FROM tasks t JOIN projects p ON p.id = t.project_id
       WHERE t.responsible_member_id = ? AND t.status IN ('todo','doing') ORDER BY t.plan_end_date`
    ).all(memberId)
  )
  const overdue = tasks.filter((t) => t.planEndDate && t.planEndDate < today())
  const pending = pendingSuggestionsFor(db, memberId)
  const timeoutMs = th.suggestTimeoutHours * 3600 * 1000
  const timedOut = pending.filter((e) => Date.now() - e.createdAt > timeoutMs)

  // S16-2：排期重叠冲突（同人多任务区间相交且未完）
  const conflicts = []
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const a = tasks[i], b = tasks[j]
      const as = a.planStartDate || a.planEndDate, ae = a.planEndDate || a.planStartDate
      const bs = b.planStartDate || b.planEndDate, be = b.planEndDate || b.planStartDate
      if (as && bs && ae && be && as <= be && bs <= ae) conflicts.push([a, b])
    }
  }

  // S23：任务行附带参考资料（SOP/知识库链接），执行人拿到完整信息
  const refMap = taskRefMap(db, tasks.map((t) => t.id))
  const taskLines = tasks.map((t) => {
    const refs = formatTaskRefs(refMap.get(t.id))
    return `- ${t.project_name} #${t.id} ${t.title} [${t.status}]${t.planEndDate ? ` 截止${t.planEndDate}${t.planEndDate < today() ? '（逾期）' : ''}` : ''}${refs ? `\n  参考：${refs}` : ''}`
  }).join('\n') || '（无未完任务）'
  let narrative
  if (llm) {
    const out = await llm.complete(
      [
        { role: 'system', content: '你是企业项目大脑，为成员生成个人梳理：给出优先处理顺序与风险提示，2-4 句中文。' },
        { role: 'user', content: `成员：${member.name}\n未完任务：\n${taskLines}\n逾期：${overdue.length}\n排期冲突：${conflicts.length}\n超时待确认建议：${timedOut.length}` },
      ]
    )
    narrative = String(out).trim()
  }
  narrative ||= `你有 ${tasks.length} 项未完任务（逾期 ${overdue.length}）、排期冲突 ${conflicts.length} 处、超时待确认建议 ${timedOut.length} 条。${overdue.length ? '建议优先处理逾期项。' : ''}`

  const body = `${timedOut.length ? `⏰ 超时待确认（置顶）：\n${timedOut.map((e) => `- ${e.summary}（事件#${e.id}）`).join('\n')}\n\n` : ''}${narrative}\n\n任务：\n${taskLines}${conflicts.length ? `\n\n排期冲突：\n${conflicts.map(([a, b]) => `- ${a.title}（${a.planStartDate}~${a.planEndDate}）与 ${b.title}（${b.planStartDate}~${b.planEndDate}）重叠`).join('\n')}` : ''}`
  notifyMember(db, camelizeRow(member), { pushType: 'digest', title: `个人梳理：${member.name}`, body })

  return { memberId, narrative, taskCount: tasks.length, overdueCount: overdue.length, conflictCount: conflicts.length, timedOutSuggestions: timedOut.length, timedOut, conflicts }
}

/** S8-2 结项复盘摘要：基于事件流的确定性生成（LLM 可增强，人工可改后作为 closeProject 入参）。 */
export async function closeoutSummary(db, projectId, { llm: llmOverride } = {}) {
  const llm = getLlm(db, llmOverride)
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId)
  const events = camelizeRows(
    db.prepare('SELECT event_type, summary, business_time FROM project_events WHERE project_id = ? ORDER BY business_time').all(projectId)
  )
  const risks = events.filter((e) => e.eventType === 'risk' || e.eventType === 'blocker')
  const decisions = events.filter((e) => e.eventType === 'decision')
  const base = `周期 ${project.plan_start_date || '?'} ~ ${project.actual_end_date || '?'}；关键决策 ${decisions.length} 条；风险/阻塞 ${risks.length} 条。` +
    (decisions.slice(0, 3).map((d) => `决策：${d.summary}`).join('；') || '')
  if (!llm) return `【复盘】${project.name}：${base}`
  const out = await llm.complete([
    { role: 'system', content: '基于项目事件流写 3 句话复盘摘要（结果/风险/经验），中文。' },
    { role: 'user', content: `项目：${project.name}\n${base}\n事件流：\n${events.slice(-30).map((e) => e.summary).join('\n')}` },
  ])
  return String(out).trim() || base
}
