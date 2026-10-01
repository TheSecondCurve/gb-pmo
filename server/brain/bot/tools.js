// S20 机器人工具面（读自由写收敛，K9）：
// query = 只读 SQL（护栏与 Agent SQL 端点同源）；metric = queryMetric 口径捷径；
// write = 语义化提议——分发器定性生效路径（record 自动生效 / suggest+bind 出确认卡 / trigger 复用 action 白名单），
// LLM 只描述想做什么，不选择也不影响生效路径。所有校验失败都返回 refused 文案（不抛出，循环保持稳定）。

import { runReadOnlyQuery } from '../../agent/sqlGuard.js'
import { ACTIONS, BOT_ACTIONS } from '../../agent/actions.js'
import { queryMetric } from '../../engine/metrics.js'
import { addEvent } from '../../engine/events.js'
import { assertValue, label } from '../../engine/enums.js'
import { pushSuggestion } from '../extract.js'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
// 建议字段 → 事件类型（与 IM 抽取器同口径，confirmEvent.applyTaskPatch 支持的字段子集）
const SUGGEST_FIELDS = {
  status: 'status_change',
  plan_start_date: 'schedule_change',
  plan_end_date: 'schedule_change',
  responsible_member_id: 'owner_change',
}

export function runQueryTool(db, sql) {
  return runReadOnlyQuery(db, sql)
}

export function runMetricTool(db, id, params) {
  return queryMetric(db, String(id || ''), params || {})
}

/**
 * 写分发。ctx: { member(绑定成员), evt(原始消息事件), llm(已解析适配器), sourcePlatform('web'|'feishu'，S24) }。
 * 返回 { type: 'receipt'|'card'|'refused', text?, result?, ...card 数据 }。
 */
export async function runWriteTool(db, { kind, payload = {} }, ctx) {
  try {
    if (kind === 'record_event') return writeRecordEvent(db, payload, ctx)
    if (kind === 'suggest_event') return writeSuggestEvent(db, payload, ctx)
    if (kind === 'bind_channel') return writeBindChannel(db, payload, ctx)
    if (kind === 'trigger') return await runTrigger(db, payload, ctx)
    return refused(`不支持的写类型: ${kind}（可用 record_event/suggest_event/bind_channel/trigger）`)
  } catch (e) {
    if (e.statusCode === 403) return refused(`权限不足：${e.message}`, 'refused_permission')
    return refused(`操作被拒绝：${e.message}`)
  }
}

function refused(text, result = 'replied') {
  return { type: 'refused', text, result }
}

function writeRecordEvent(db, payload, ctx) {
  const projectId = Number(payload.projectId)
  const project = projectId ? db.prepare('SELECT id, name FROM projects WHERE id = ?').get(projectId) : null
  if (!project) return refused('projectId 必填且须为真实项目 id（先 query 查项目）')
  const eventType = assertValue('eventType', String(payload.eventType || 'progress'))
  const summary = String(payload.summary || '').trim()
  if (!summary) return refused('summary 必填（一句中文摘要）')
  const evt = addEvent(db, {
    projectId, businessTime: ctx.evt?.ts || Date.now(), nature: 'record', eventType,
    summary: summary.slice(0, 200), rawSnapshot: (ctx.evt?.text || '').slice(0, 2000) || null,
    sourcePlatform: ctx.sourcePlatform || 'feishu', sourceRef: ctx.evt?.messageId || null,
    speakerMemberId: ctx.member.id, speakerLabel: ctx.member.name, generatedBy: 'agent',
  })
  return { type: 'receipt', text: `已登记${label('eventType', eventType)}事件 #${evt.id}（项目「${project.name}」），归因 ${ctx.member.name}。` }
}

function writeSuggestEvent(db, payload, ctx) {
  const taskId = Number(payload.targetTaskId)
  const task = taskId
    ? db.prepare('SELECT t.id, t.title, t.project_id AS pid, p.status AS project_status FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = ?').get(taskId)
    : null
  if (!task) return refused('targetTaskId 必填且须为真实任务 id（先 query 查任务）')
  if (task.project_status === 'closed' || task.project_status === 'cancelled') return refused('项目已结项/取消，任务面只读')
  if (payload.projectId !== undefined && payload.projectId !== null && Number(payload.projectId) !== task.pid) {
    return refused('任务不属于该项目')
  }
  const field = String(payload.targetField || '')
  if (!(field in SUGGEST_FIELDS)) return refused('targetField 仅支持 status / plan_start_date / plan_end_date / responsible_member_id')
  let value = payload.targetValue
  let valueLabel
  if (field === 'status') {
    value = assertValue('taskStatus', String(value))
    valueLabel = label('taskStatus', value)
  } else if (field === 'plan_start_date' || field === 'plan_end_date') {
    if (!DATE_RE.test(String(value))) return refused('日期值须为 YYYY-MM-DD（按今天自己换算）')
    valueLabel = String(value)
  } else {
    value = Number(value)
    const m = db.prepare(`SELECT id, name FROM members WHERE id = ? AND status = 'active'`).get(value)
    if (!m) return refused('责任人须为在职成员 id（先 query 查成员）')
    valueLabel = m.name
  }
  const fieldLabel = { status: '状态', plan_start_date: '计划开始日', plan_end_date: '计划结束日', responsible_member_id: '责任人' }[field]
  const summary = String(payload.summary || '').trim() || `任务「${task.title}」${fieldLabel} → ${valueLabel}`
  const evt = addEvent(db, {
    projectId: task.pid, businessTime: ctx.evt?.ts || Date.now(), nature: 'suggestion',
    eventType: SUGGEST_FIELDS[field], summary: summary.slice(0, 200),
    rawSnapshot: (ctx.evt?.text || '').slice(0, 2000) || null,
    sourcePlatform: ctx.sourcePlatform || 'feishu', sourceRef: ctx.evt?.messageId || null,
    speakerMemberId: ctx.member.id, speakerLabel: ctx.member.name,
    targetTaskId: taskId, targetField: field, targetValue: String(value), generatedBy: 'agent',
  })
  pushSuggestion(db, evt) // 既有语义：推目标任务责任人 + 项目牵头人（pushes 表）
  return { type: 'card', cardKind: 'suggest', eventId: evt.id, summary: evt.summary, eventType: evt.eventType }
}

function writeBindChannel(db, payload, ctx) {
  if (ctx.evt?.chatType !== 'group') return refused('群登记只在群聊里可用')
  const projectId = Number(payload.projectId)
  const project = projectId ? db.prepare('SELECT id, name, lead_member_id FROM projects WHERE id = ?').get(projectId) : null
  if (!project) return refused('projectId 必填且须为真实项目 id（先 query 查项目）')
  if (ctx.member.role !== 'admin' && project.lead_member_id !== ctx.member.id) {
    return refused('只有该项目的牵头人或系统管理员可以登记群，请 TA 来 @我登记', 'refused_permission')
  }
  return {
    type: 'card', cardKind: 'bind',
    projectId: project.id, projectName: project.name,
    chatId: ctx.evt.chatId, chatName: String(payload.chatName || ctx.evt.chatTitle || ''),
  }
}

async function runTrigger(db, payload, ctx) {
  const name = String(payload.name || '')
  if (!BOT_ACTIONS.includes(name)) return refused(`触发动作仅支持：${BOT_ACTIONS.join(' / ')}`)
  const spec = ACTIONS[name]
  const result = await spec.run(payload.params || {}, { db, member: ctx.member, llm: ctx.llm ?? undefined })
  return { type: 'receipt', text: `已触发 ${name}：${JSON.stringify(result).slice(0, 600)}` }
}
