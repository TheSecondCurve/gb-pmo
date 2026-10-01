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
import { createProposal, PROPOSAL_KINDS } from '../../engine/proposals.js'

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
    if (kind === 'propose') return writePropose(db, payload, ctx)
    return refused(`不支持的写类型: ${kind}（可用 record_event/suggest_event/bind_channel/trigger/propose）`)
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

// —— S25（v0.17）项目级/配置级提议：软校验（真实 id + 合法枚举 + 摘要化），生效见 engine/proposals.js ——

const normTasks = (tasks) => (Array.isArray(tasks) ? tasks : []).map((t) => (typeof t === 'string' ? { title: t } : t)).filter((t) => t && t.title)
const DATE_OK = /^\d{4}-\d{2}-\d{2}$/

function writePropose(db, payload, ctx) {
  const kind = String(payload?.kind || '')
  if (!PROPOSAL_KINDS[kind]) return refused(`不支持的提议类型: ${kind}（可用 ${Object.keys(PROPOSAL_KINDS).join(' / ')}）`)
  const check = softValidateProposal(db, kind, payload)
  if (check.error) return refused(check.error)
  const prop = createProposal(db, { kind, payload: check.payload, summary: check.summary, proposedBy: ctx.member.id })
  return { type: 'card', cardKind: 'propose', proposalId: prop.id, kind, summary: prop.summary }
}

function getProj(db, id) {
  return Number(id) ? db.prepare('SELECT id, name, status, lead_member_id, plan_end_date FROM projects WHERE id = ?').get(Number(id)) : null
}

function softValidateProposal(db, kind, p) {
  if (kind === 'update_project_status') {
    const proj = getProj(db, p.projectId)
    if (!proj) return { error: 'projectId 必填且须为真实项目 id（先 query 查项目）' }
    const status = String(p.status || '')
    if (!['planning', 'active', 'paused'].includes(status)) {
      return { error: 'status 仅支持 planning/active/paused（结项请用 close_project）' }
    }
    const payload = { projectId: proj.id, status }
    let detail = `${label('projectStatus', proj.status)} → ${label('projectStatus', status)}`
    if (status === 'active') {
      const endDate = String(p.planEndDate || proj.plan_end_date || '')
      if (!DATE_OK.test(endDate)) return { error: '项目尚无交付日期：启动提议须同时带 planEndDate（YYYY-MM-DD，S21）' }
      if (!proj.plan_end_date) { payload.planEndDate = endDate; detail += `，补交付日期 ${endDate}` }
    }
    return { payload, summary: `项目「${proj.name}」状态 ${detail}` }
  }
  if (kind === 'close_project') {
    const proj = getProj(db, p.projectId)
    if (!proj) return { error: 'projectId 必填且须为真实项目 id（先 query 查项目）' }
    const open = db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND status != 'done'`).get(proj.id).n
    return {
      payload: { projectId: proj.id, ...(p.summary ? { summary: String(p.summary).slice(0, 200) } : {}) },
      summary: `项目「${proj.name}」结项${open ? `（还有 ${open} 个未完成任务，确认时按 S8 校验）` : '（任务已全部完成）'}`,
    }
  }
  if (kind === 'create_project') {
    if (!String(p.name || '').trim()) return { error: 'name 必填（项目名）' }
    if (!p.leadMemberId) return { error: 'leadMemberId 必填（拟任牵头人 id，先 query 查成员）' }
    const lead = db.prepare(`SELECT id, name FROM members WHERE id = ? AND status = 'active'`).get(Number(p.leadMemberId))
    if (!lead) return { error: '牵头人不存在或已离职（先 query 查成员）' }
    if (!p.typeCode && !p.templateCode) return { error: 'typeCode 必填（项目类型编码，先 query 查 project_types）' }
    if (p.typeCode && !db.prepare(`SELECT code FROM project_types WHERE code = ? AND status = 'active'`).get(String(p.typeCode))) {
      return { error: `项目类型 ${p.typeCode} 不存在或已停用（先 query 查 project_types）` }
    }
    if (p.planEndDate && !DATE_OK.test(String(p.planEndDate))) return { error: 'planEndDate 须为 YYYY-MM-DD' }
    return {
      payload: {
        name: String(p.name).trim().slice(0, 100), typeCode: p.typeCode ? String(p.typeCode) : undefined,
        templateCode: p.templateCode ? String(p.templateCode) : undefined, leadMemberId: lead.id,
        ...(p.priority ? { priority: String(p.priority) } : {}), ...(p.clientName ? { clientName: String(p.clientName) } : {}),
        ...(p.planStartDate ? { planStartDate: String(p.planStartDate) } : {}), ...(p.planEndDate ? { planEndDate: String(p.planEndDate) } : {}),
      },
      summary: `立项「${String(p.name).trim()}」（类型 ${p.typeCode || p.templateCode}，牵头人 ${lead.name}${p.planEndDate ? `，交付 ${p.planEndDate}` : ''}）`,
    }
  }
  if (kind === 'create_task_template') {
    if (!p.code || !p.name) return { error: 'code/name 必填（模板编码与名称）' }
    if (db.prepare('SELECT 1 FROM project_templates WHERE code = ?').get(String(p.code))) return { error: `模板编码已存在: ${p.code}` }
    const tasks = normTasks(p.tasks)
    if (!tasks.length) return { error: 'tasks 必填（任务标题数组，1~30 条）' }
    return {
      payload: { code: String(p.code), name: String(p.name), ...(p.description ? { description: String(p.description) } : {}), tasks },
      summary: `新建任务模板「${p.name}」（${p.code}，${tasks.length} 项任务）`,
    }
  }
  if (kind === 'update_task_template') {
    const tpl = p.templateId
      ? db.prepare('SELECT id, code, name FROM project_templates WHERE id = ?').get(Number(p.templateId))
      : db.prepare('SELECT id, code, name FROM project_templates WHERE code = ?').get(String(p.templateCode || ''))
    if (!tpl) return { error: 'templateCode（或 templateId）必填且须为真实任务模板（先 query 查 project_templates）' }
    if (p.name === undefined && p.description === undefined && p.tasks === undefined) return { error: '至少给出 name / description / tasks 之一（tasks 给出即整体替换，只影响未来立项）' }
    const parts = []
    if (p.name !== undefined) parts.push('改名')
    if (p.description !== undefined) parts.push('改说明')
    if (p.tasks !== undefined) parts.push(`任务清单整体替换为 ${normTasks(p.tasks).length} 项`)
    return {
      payload: { templateId: tpl.id, ...(p.name !== undefined ? { name: String(p.name) } : {}), ...(p.description !== undefined ? { description: String(p.description ?? '') } : {}), ...(p.tasks !== undefined ? { tasks: normTasks(p.tasks) } : {}) },
      summary: `修改任务模板「${tpl.name}」（${tpl.code}）：${parts.join('、')}`,
    }
  }
  if (kind === 'create_project_type') {
    if (!p.code || !p.name) return { error: 'code/name 必填（类型编码与名称）' }
    if (!p.defaultTemplateCode) return { error: 'defaultTemplateCode 必填（绑定的默认任务模板编码，先 query 查 project_templates）' }
    if (db.prepare('SELECT 1 FROM project_types WHERE code = ?').get(String(p.code))) return { error: `类型编码已存在: ${p.code}` }
    const tpl = db.prepare('SELECT id, code FROM project_templates WHERE code = ?').get(String(p.defaultTemplateCode))
    if (!tpl) return { error: `任务模板 ${p.defaultTemplateCode} 不存在（先 query 查 project_templates）` }
    return {
      payload: { code: String(p.code), name: String(p.name), ...(p.description ? { description: String(p.description) } : {}), defaultTemplateCode: tpl.code },
      summary: `新建项目类型「${p.name}」（${p.code}，默认模板 ${tpl.code}）`,
    }
  }
  return { error: `未知提议类型 ${kind}` }
}

async function runTrigger(db, payload, ctx) {
  const name = String(payload.name || '')
  if (!BOT_ACTIONS.includes(name)) return refused(`触发动作仅支持：${BOT_ACTIONS.join(' / ')}`)
  const spec = ACTIONS[name]
  const result = await spec.run(payload.params || {}, { db, member: ctx.member, llm: ctx.llm ?? undefined })
  return { type: 'receipt', text: `已触发 ${name}：${JSON.stringify(result).slice(0, 600)}` }
}
