// S20 机器人工具面（读自由写收敛，K9）：
// query = 只读 SQL（护栏与 Agent SQL 端点同源）；metric = queryMetric 口径捷径；
// write = 语义化提议——分发器定性生效路径（record 自动生效 / suggest+bind 出确认卡 / trigger 复用 action 白名单），
// LLM 只描述想做什么，不选择也不影响生效路径。所有校验失败都返回 refused 文案（不抛出，循环保持稳定）。

import { runReadOnlyQuery } from '../../agent/sqlGuard.js'
import { ACTIONS, BOT_ACTIONS } from '../../agent/actions.js'
import { queryMetric } from '../../engine/metrics.js'
import { projectBrief } from '../../engine/brief.js'
import { addEvent } from '../../engine/events.js'
import { assertValue, label } from '../../engine/enums.js'
import { pushSuggestion, mapSpeaker } from '../extract.js'
import { createProposal, PROPOSAL_KINDS } from '../../engine/proposals.js'
import { normalizeTypeTasks } from '../../engine/projectTypes.js'
import { getSetting } from '../../engine/settings.js'
import { camelizeRow } from '../../db/index.mjs'
import * as feishuConnector from '../connectors/feishu.js'
import * as wecomConnector from '../connectors/wecom.js'

const CHAT_CONNECTORS = { feishu: feishuConnector, wecom: wecomConnector }
const RECENT_CHAT_LOOKBACK_SEC = 7200 // 回看窗口：最近 2 小时群讨论
const RECENT_CHAT_MAX = 50 // 单次返回条数上限

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

/** 项目 Brief（S27）：一次取全单个项目的结构化摘要（engine 确定性组装，LLM 只叙述）。 */
export function runBriefTool(db, projectId) {
  return projectBrief(db, Number(projectId))
}

/**
 * S20-18（v0.34）群讨论上下文：仅项目专题群——连接器临时拉本群最近消息给 LLM 读。
 * 临时拉取不挪 channels.cursor、不产生事件（定时抽取与 S20-10 去重不受影响）；
 * 说话人按 feishu/wecom id 映射成员（未识别标注），机器人自身消息（bot_commands 已有）过滤。
 * env: { platform, chatId, chatType }；opts.fetchChat 可注入替换默认连接器（测试用）。
 */
export async function runRecentChatTool(db, env, { fetchChat, limit } = {}) {
  const unavailable = 'recent_chat 仅项目专题群可用——本会话没有定域的群讨论上下文；请改用 query 查已抽取事件，或让用户直接补充讨论结论。'
  if (env.chatType !== 'group') return unavailable
  const chRaw = db.prepare('SELECT * FROM channels WHERE platform = ? AND group_key = ?').get(env.platform, env.chatId)
  if (!chRaw || chRaw.channel_type !== 'dedicated') return unavailable
  const channel = camelizeRow(chRaw)
  const take = Math.min(Math.max(1, Number(limit) || 20), RECENT_CHAT_MAX)
  const fetch = fetchChat || CHAT_CONNECTORS[env.platform]?.fetchMessages
  if (!fetch) return `recent_chat 失败：平台 ${env.platform} 无消息连接器。`
  try {
    const cursor = String(Math.floor(Date.now() / 1000) - RECENT_CHAT_LOOKBACK_SEC)
    const { messages = [] } = await fetch(getSetting(db, `im.${env.platform}`), channel, cursor)
    const botSeen = db.prepare('SELECT 1 FROM bot_commands WHERE message_id = ?')
    const lines = messages
      .filter((m) => m.id && !botSeen.get(m.id))
      .map((m) => `${mapSpeaker(db, env.platform, m.speakerId)?.name || '未识别'}：${String(m.text || '').slice(0, 200)}`)
    if (!lines.length) {
      return `本群最近 ${RECENT_CHAT_LOOKBACK_SEC / 3600} 小时内没有可读的群聊讨论（无人发言或均为机器人消息）。请让用户直接说明讨论结论。`
    }
    return `本群最近讨论（${lines.length} 条，从旧到新；仅近期窗口，更早内容走定时抽取归档）：\n${lines.slice(-take).join('\n')}`
  } catch (e) {
    return `recent_chat 失败：${e.message}（可改用 query 查已抽取事件，或让用户直接复述讨论结论）`
  }
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
  const milestoneId = Number(payload.targetMilestoneId)
  if (milestoneId) return writeMilestoneSuggest(db, payload, ctx, milestoneId) // S35：里程碑改期/状态
  const taskId = Number(payload.targetTaskId)
  const task = taskId
    ? db.prepare('SELECT t.id, t.title, t.project_id AS pid, p.status AS project_status FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = ? AND t.deleted_at IS NULL').get(taskId)
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

// S35：里程碑建议——建议通道扩展到里程碑（target_object='milestone'，确认走 events.applyMilestonePatch）。
// 全员可确认口径与任务建议一致（v0.34）；plan_date 改期 / status 达成·延误·取消（met 落实际日期在确认侧）。
const MILESTONE_FIELDS = { plan_date: 'schedule_change', status: 'status_change' }

function writeMilestoneSuggest(db, payload, ctx, milestoneId) {
  const ms = db
    .prepare('SELECT m.id, m.name, m.project_id AS pid, p.status AS project_status FROM milestones m JOIN projects p ON p.id = m.project_id WHERE m.id = ?')
    .get(milestoneId)
  if (!ms) return refused('targetMilestoneId 必填且须为真实里程碑 id（先 query 查里程碑）')
  if (ms.project_status === 'closed' || ms.project_status === 'cancelled') return refused('项目已结项/取消，任务面只读')
  if (payload.projectId !== undefined && payload.projectId !== null && Number(payload.projectId) !== ms.pid) {
    return refused('里程碑不属于该项目')
  }
  const field = String(payload.targetField || '')
  if (!(field in MILESTONE_FIELDS)) return refused('targetField 仅支持 plan_date / status')
  let value = payload.targetValue
  let valueLabel
  if (field === 'plan_date') {
    if (!DATE_RE.test(String(value))) return refused('日期值须为 YYYY-MM-DD（按今天自己换算）')
    valueLabel = String(value)
  } else {
    try {
      value = assertValue('milestoneStatus', String(value))
      valueLabel = label('milestoneStatus', value)
    } catch {
      return refused('状态值须为 planned / met / missed / cancelled')
    }
  }
  const fieldLabel = { plan_date: '计划日期', status: '状态' }[field]
  const summary = String(payload.summary || '').trim() || `里程碑「${ms.name}」${fieldLabel} → ${valueLabel}`
  const evt = addEvent(db, {
    projectId: ms.pid, businessTime: ctx.evt?.ts || Date.now(), nature: 'suggestion',
    eventType: MILESTONE_FIELDS[field], summary: summary.slice(0, 200),
    rawSnapshot: (ctx.evt?.text || '').slice(0, 2000) || null,
    sourcePlatform: ctx.sourcePlatform || 'feishu', sourceRef: ctx.evt?.messageId || null,
    speakerMemberId: ctx.member.id, speakerLabel: ctx.member.name,
    targetObject: 'milestone', targetTaskId: milestoneId, targetField: field, targetValue: String(value), generatedBy: 'agent',
  })
  pushSuggestion(db, evt)
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

/** S33：提议载荷里的任务参考提前校验（复用引擎归一；确认时引擎兜底再校验一次）。 */
const checkTaskRefs = (tasks) => {
  try {
    normalizeTypeTasks(tasks.map((t) => (typeof t === 'string' ? { title: t } : t)))
    return ''
  } catch (e) {
    return e.message
  }
}
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
  if (kind === 'cancel_project') {
    const proj = getProj(db, p.projectId)
    if (!proj) return { error: 'projectId 必填且须为真实项目 id（先 query 查项目）' }
    const reason = String(p.reason || '').trim()
    if (!reason) return { error: 'reason 必填（S29：取消项目必须留原因文本）' }
    if (proj.status !== 'active') return { error: `项目已是终态（${label('projectStatus', proj.status)}），不可再取消` }
    return { payload: { projectId: proj.id, reason: reason.slice(0, 200) }, summary: `取消项目「${proj.name}」：${reason}` }
  }
  if (kind === 'close_project') {
    const proj = getProj(db, p.projectId)
    if (!proj) return { error: 'projectId 必填且须为真实项目 id（先 query 查项目）' }
    const summaryText = String(p.summary || '').trim()
    if (!summaryText) return { error: 'summary 必填（S29：结项必须留结项总结；可先基于事件流起草）' }
    if (proj.status !== 'active') return { error: `项目已是终态（${label('projectStatus', proj.status)}），不可再结项` }
    const open = db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND status != 'done' AND deleted_at IS NULL`).get(proj.id).n
    return {
      payload: { projectId: proj.id, summary: summaryText.slice(0, 200) },
      summary: `项目「${proj.name}」结项：${summaryText}${open ? `（还有 ${open} 个未完成任务，确认时按 S8 校验）` : '（任务已全部完成）'}`,
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
    if (p.planStartDate && !DATE_OK.test(String(p.planStartDate))) return { error: 'planStartDate 须为 YYYY-MM-DD' }
    const tasks = normTasks(p.tasks)
    if (tasks.some((t) => !String(t.title).trim())) return { error: 'tasks 内不可有空白标题' }
    if (tasks.length > 30) return { error: 'tasks 至多 30 条' }
    const refErr = checkTaskRefs(tasks) // S33：带 refs 的任务项提前校验（引擎在确认时兜底）
    if (refErr) return { error: refErr }
    const autoSchedule = p.autoSchedule === true
    if (autoSchedule && !p.planEndDate) return { error: 'autoSchedule 倒排须同时给 planEndDate（交付日期，YYYY-MM-DD）' }
    return {
      payload: {
        name: String(p.name).trim().slice(0, 100), typeCode: p.typeCode ? String(p.typeCode) : undefined,
        templateCode: p.templateCode ? String(p.templateCode) : undefined, leadMemberId: lead.id,
        ...(p.priority ? { priority: String(p.priority) } : {}), ...(p.clientName ? { clientName: String(p.clientName) } : {}),
        ...(p.planStartDate ? { planStartDate: String(p.planStartDate) } : {}), ...(p.planEndDate ? { planEndDate: String(p.planEndDate) } : {}),
        ...(p.tasks !== undefined ? { tasks } : {}), ...(autoSchedule ? { autoSchedule: true } : {}),
      },
      summary: `立项「${String(p.name).trim()}」（类型 ${p.typeCode || p.templateCode}，牵头人 ${lead.name}${tasks.length ? `，任务 ${tasks.length} 项` : ''}${p.planEndDate ? `，交付 ${p.planEndDate}` : ''}${autoSchedule ? '，按交付日期倒排任务' : ''}）`,
    }
  }
  if (kind === 'create_project_type') {
    if (!p.code || !p.name) return { error: 'code/name 必填（类型编码与名称）' }
    if (db.prepare('SELECT 1 FROM project_types WHERE code = ?').get(String(p.code))) return { error: `类型编码已存在: ${p.code}` }
    const tasks = normTasks(p.tasks)
    if (tasks.some((t) => !String(t.title).trim())) return { error: 'tasks 内不可有空白标题' }
    if (tasks.length > 30) return { error: 'tasks 至多 30 条' }
    const refErr = checkTaskRefs(tasks) // S33：类型模板步骤可挂参考链接（提议提前校验，引擎确认时兜底）
    if (refErr) return { error: refErr }
    return {
      payload: {
        code: String(p.code), name: String(p.name), ...(p.description ? { description: String(p.description) } : {}),
        ...(p.initPrompt ? { initPrompt: String(p.initPrompt) } : {}), // S39：初始化提示词透传（引擎确认时校验）
        tasks,
      },
      summary: `新建项目类型「${p.name}」（${p.code}，内嵌任务 ${tasks.length} 项${tasks.reduce((s, t) => s + ((t.refs ?? []).length), 0) ? `，参考资料 ${tasks.reduce((s, t) => s + ((t.refs ?? []).length), 0)} 条` : ''}）`,
    }
  }
  // —— S35 项目维护面：建任务 / 建里程碑 / 项目信息变更（软校验，硬校验在引擎确认时兜底）——
  if (kind === 'add_task') {
    const proj = getProj(db, p.projectId)
    if (!proj) return { error: 'projectId 必填且须为真实项目 id（先 query 查项目）' }
    const title = String(p.title || '').trim()
    if (!title) return { error: 'title 必填（任务标题）' }
    if (p.planStartDate && !DATE_OK.test(String(p.planStartDate))) return { error: 'planStartDate 须为 YYYY-MM-DD' }
    if (p.planEndDate && !DATE_OK.test(String(p.planEndDate))) return { error: 'planEndDate 须为 YYYY-MM-DD' }
    let owner = null
    if (p.responsibleMemberId != null) {
      owner = db.prepare(`SELECT id, name FROM members WHERE id = ? AND status = 'active'`).get(Number(p.responsibleMemberId))
      if (!owner) return { error: '责任人不存在或已离职（先 query 查成员）' }
    }
    return {
      payload: {
        projectId: proj.id, title: title.slice(0, 200),
        ...(owner ? { responsibleMemberId: owner.id } : {}),
        ...(p.planStartDate ? { planStartDate: String(p.planStartDate) } : {}),
        ...(p.planEndDate ? { planEndDate: String(p.planEndDate) } : {}),
      },
      summary: `项目「${proj.name}」新增任务「${title.slice(0, 200)}」（责任人 ${owner ? owner.name : '未指派'}${p.planEndDate ? `，截止 ${p.planEndDate}` : ''}）`,
    }
  }
  if (kind === 'add_milestone') {
    const proj = getProj(db, p.projectId)
    if (!proj) return { error: 'projectId 必填且须为真实项目 id（先 query 查项目）' }
    const name = String(p.name || '').trim()
    if (!name) return { error: 'name 必填（里程碑名称）' }
    if (p.planDate && !DATE_OK.test(String(p.planDate))) return { error: 'planDate 须为 YYYY-MM-DD' }
    return {
      payload: { projectId: proj.id, name: name.slice(0, 200), ...(p.planDate ? { planDate: String(p.planDate) } : {}) },
      summary: `项目「${proj.name}」新增里程碑「${name.slice(0, 200)}」${p.planDate ? `（${p.planDate}）` : ''}`,
    }
  }
  if (kind === 'update_project') {
    const proj = getProj(db, p.projectId)
    if (!proj) return { error: 'projectId 必填且须为真实项目 id（先 query 查项目）' }
    if ('status' in p) return { error: '项目状态仅可经结项/取消变更（S29）：请走 close_project / cancel_project 提议' }
    const KEYS = ['name', 'clientName', 'priority', 'planStartDate', 'planEndDate', 'leadMemberId']
    const changes = []
    const payloadOut = { projectId: proj.id }
    for (const key of KEYS) {
      if (p[key] === undefined) continue
      let value = p[key]
      if (key === 'priority') {
        try { assertValue('priority', String(value)) } catch { return { error: `priority 非法: ${value}（high|medium|low）` } }
      }
      if ((key === 'planStartDate' || key === 'planEndDate') && !DATE_OK.test(String(value))) return { error: `${key} 须为 YYYY-MM-DD` }
      if (key === 'leadMemberId') {
        const m = db.prepare(`SELECT id, name FROM members WHERE id = ? AND status = 'active'`).get(Number(value))
        if (!m) return { error: '新牵头人不存在或已离职（先 query 查成员）' }
        changes.push(`牵头人→${m.name}`)
        value = m.id
      } else {
        changes.push(`${key}→${value}`)
      }
      payloadOut[key] = value
    }
    if (!changes.length) return { error: '至少提供一个要变更的字段（name/clientName/priority/planStartDate/planEndDate/leadMemberId）' }
    return { payload: payloadOut, summary: `项目「${proj.name}」变更：${changes.join('、')}` }
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
