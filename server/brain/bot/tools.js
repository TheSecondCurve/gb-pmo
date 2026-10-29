// S20 机器人工具面（读自由写收敛，K9）：
// query = 只读 SQL（护栏与 Agent SQL 端点同源）；metric = queryMetric 口径捷径；
// write = 语义化写动作——分发器定性生效路径（record 自动生效 / suggest 直改回执〔v0.46/K25：落建议型事件
// 立即以发令人身份走 confirmEvent 生效，支持 items 批量〕/ bind 直写 / propose 仅取消·结项出确认卡、
// 其余 kind 权限前置直写 / trigger 复用 action 白名单），LLM 只描述想做什么，不选择也不影响生效路径。
// 所有校验失败都返回 refused 文案（不抛出，循环保持稳定）。

import { runReadOnlyQuery } from '../../agent/sqlGuard.js'
import { ACTIONS, BOT_ACTIONS } from '../../agent/actions.js'
import { queryMetric } from '../../engine/metrics.js'
import { projectBrief } from '../../engine/brief.js'
import { addEvent, confirmEvent } from '../../engine/events.js'
import { assertValue, label } from '../../engine/enums.js'
import { mapSpeaker } from '../extract.js'
import { upsertChannel, canManageChannel } from '../../engine/tasks.js'
import { createProposal, PROPOSAL_KINDS } from '../../engine/proposals.js'
import { normalizeTypeTasks, normalizeWeekdays } from '../../engine/projectTypes.js'
import { planTypeTasks, createProject, closeProject } from '../../engine/projects.js'
import { bindProjectWiki, recordToWiki, getDefaultParentToken, getProjectWiki, wikiPageUrl } from '../../engine/wiki.js'
import { getSetting } from '../../engine/settings.js'
import { camelizeRow } from '../../db/index.mjs'
import { today } from '../../db/time.js'
import { findRoutineTaskByHint, setDayStatus, weekdaysLabel } from '../../engine/dailyBoard.js'
import { buildInitAssignCard } from './cards.js'
import * as feishuConnector from '../connectors/feishu.js'
import * as wecomConnector from '../connectors/wecom.js'

const CHAT_CONNECTORS = { feishu: feishuConnector, wecom: wecomConnector }
const RECENT_CHAT_LOOKBACK_SEC = 7200 // 回看窗口：最近 2 小时群讨论
const RECENT_CHAT_MAX = 50 // 单次返回条数上限
const MINUTES_MAX_HOURS = 6 // S54：纪要回看窗上限（默认 2 小时同 recent_chat）

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
 * 专题群最近讨论的共享拉取（S20-18 recent_chat / S54 minutes 共用）：
 * 仅专题群可用、临时拉取不挪 channels.cursor 不产事件、说话人身份映射、机器人自身消息过滤。
 */
async function fetchRecentDiscussion(db, env, { fetchChat, limit, lookbackSec }) {
  const chRaw = env.chatType === 'group'
    ? db.prepare('SELECT * FROM channels WHERE platform = ? AND group_key = ?').get(env.platform, env.chatId)
    : null
  if (!chRaw || chRaw.channel_type !== 'dedicated') return { unavailable: true }
  const channel = camelizeRow(chRaw)
  const take = Math.min(Math.max(1, Number(limit) || 20), RECENT_CHAT_MAX)
  const fetch = fetchChat || CHAT_CONNECTORS[env.platform]?.fetchMessages
  if (!fetch) return { unavailable: true, reason: `平台 ${env.platform} 无消息连接器。` }
  const cursor = String(Math.floor(Date.now() / 1000) - lookbackSec)
  const { messages = [] } = await fetch(getSetting(db, `im.${env.platform}`), channel, cursor)
  const botSeen = db.prepare('SELECT 1 FROM bot_commands WHERE message_id = ?')
  const lines = messages
    .filter((m) => m.id && !botSeen.get(m.id))
    .map((m) => `${mapSpeaker(db, env.platform, m.speakerId)?.name || '未识别'}：${String(m.text || '').slice(0, 200)}`)
  return { lines, take }
}

/**
 * S20-18（v0.34）群讨论上下文：仅项目专题群——连接器临时拉本群最近消息给 LLM 读。
 * 临时拉取不挪 channels.cursor、不产生事件（定时抽取与 S20-10 去重不受影响）；
 * 说话人按 feishu/wecom id 映射（未识别标注），机器人自身消息（bot_commands 已有）过滤。
 * env: { platform, chatId, chatType }；opts.fetchChat 可注入替换默认连接器（测试用）。
 */
export async function runRecentChatTool(db, env, { fetchChat, limit } = {}) {
  const unavailable = 'recent_chat 仅项目专题群可用——本会话没有定域的群讨论上下文；请改用 query 查已抽取事件，或让用户直接补充讨论结论。'
  try {
    const r = await fetchRecentDiscussion(db, env, { fetchChat, limit, lookbackSec: RECENT_CHAT_LOOKBACK_SEC })
    if (r.unavailable) return r.reason ? `recent_chat 失败：${r.reason}` : unavailable
    if (!r.lines.length) {
      return `本群最近 ${RECENT_CHAT_LOOKBACK_SEC / 3600} 小时内没有可读的群聊讨论（无人发言或均为机器人消息）。请让用户直接说明讨论结论。`
    }
    return `本群最近讨论（${r.lines.length} 条，从旧到新；仅近期窗口，更早内容走定时抽取归档）：\n${r.lines.slice(-r.take).join('\n')}`
  } catch (e) {
    return `recent_chat 失败：${e.message}（可改用 query 查已抽取事件，或让用户直接复述讨论结论）`
  }
}

/**
 * S54（v0.59，K37）纪要拉取：minutes 读侧动作——与 recent_chat 同族同纪律（不挪游标/不产事件/身份映射/滤机器人），
 * 回看窗可放宽至 6 小时（默认 2h）。返回讨论文本供 LLM 浓缩三段式纪要；归档由 record_event 承担（用户确认后）。
 */
export async function runMinutesTool(db, env, { fetchChat, limit, hours } = {}) {
  const unavailable = 'minutes 仅项目专题群可用——本会话没有定域的群聊上下文（纪要在项目专题群里 @我 发起）。'
  const h = Math.min(Math.max(Number(hours) || 2, 1), MINUTES_MAX_HOURS)
  try {
    const r = await fetchRecentDiscussion(db, env, { fetchChat, limit: limit ?? RECENT_CHAT_MAX, lookbackSec: h * 3600 })
    if (r.unavailable) return r.reason ? `minutes 失败：${r.reason}` : unavailable
    if (!r.lines.length) return `本群最近 ${h} 小时内没有可读的群聊讨论（无人发言或均为机器人消息）——明说即可，不要编造纪要内容。`
    return `本群最近 ${h} 小时讨论（${r.lines.length} 条，从旧到新）：\n${r.lines.slice(-r.take).join('\n')}\n—— 请浓缩为三段式纪要（结论/待办/风险，标注发言人），末尾附「回复『归档』沉淀为项目记录」。`
  } catch (e) {
    return `minutes 失败：${e.message}（可让用户直接复述讨论结论）`
  }
}

/**
 * 写分发。ctx: { member(绑定成员), evt(原始消息事件), llm(已解析适配器), sourcePlatform('web'|'feishu'，S24) }。
 * 返回 { type: 'receipt'|'card'|'refused', text?, result?, ...card 数据 }。
 */
export async function runWriteTool(db, { kind, payload = {} }, ctx) {
  try {
    if (kind === 'record_event') return writeRecordEvent(db, payload, ctx)
    if (kind === 'record_wiki') return await writeRecordWiki(db, payload, ctx)
    if (kind === 'bind_wiki') return await writeBindWiki(db, payload, ctx)
    if (kind === 'suggest_event') return writeSuggestEvent(db, payload, ctx)
    if (kind === 'checkin_task') return writeCheckinTask(db, payload, ctx)
    if (kind === 'bind_channel') return writeBindChannel(db, payload, ctx)
    if (kind === 'quick_create_project') return await runQuickCreate(db, payload, ctx) // S70：新群快速立项一条链
    if (kind === 'trigger') return await runTrigger(db, payload, ctx)
    if (kind === 'propose') return await writePropose(db, payload, ctx)
    if (kind === 'init_assign') return await writeInitAssign(db, payload, ctx)
    if (kind === 'wiki_archive') return await writeWikiArchive(db, payload, ctx) // S73：项目汇总归档（异步回执）
    if (kind === 'close_project') return await writeCloseProject(db, payload, ctx) // S74：结项一条链（web 回落提议）
    return refused(`不支持的写类型: ${kind}（可用 record_event/record_wiki/bind_wiki/suggest_event/checkin_task/bind_channel/trigger/propose/init_assign/wiki_archive/close_project）`)
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

/**
 * S20-2（v0.46/K25）任务/里程碑变更直改：落建议型事件（讨论面留痕结构不变）并立即以发令人身份
 * 走 confirmEvent 同一口子生效（终态/软删守卫与事务全继承，decided_by=发令人）——对话面是人的明确指令，
 * 确认卡只留取消/结项等终态操作。一条指令含多个变更时用 payload.items 批量（≤20 条）：
 * 逐条独立生效、一条汇总回执单列失败原因（best-effort，不整体回滚）。
 */
function writeSuggestEvent(db, payload, ctx) {
  const items = Array.isArray(payload.items) ? payload.items : [payload]
  if (!items.length) return refused('items 不能为空（单条变更直接给 targetTaskId/targetField/targetValue）')
  if (items.length > 20) return refused('一条指令批量变更至多 20 条')
  if (items.length === 1) {
    const r = applySuggestion(db, items[0], ctx) // 校验/生效失败抛错，由 runWriteTool 统一转 refused
    return { type: 'receipt', text: `已生效：${r.summary}（事件 #${r.eventId}）。` }
  }
  const ok = []
  const failed = []
  for (const item of items) {
    try {
      ok.push(applySuggestion(db, item, ctx))
    } catch (e) {
      failed.push({ label: Number(item?.targetMilestoneId) ? `里程碑 #${item.targetMilestoneId}` : `任务 #${item?.targetTaskId}`, message: e.message })
    }
  }
  if (!ok.length) return refused(`批量变更全部失败：${failed.map((f) => `${f.label}（${f.message}）`).join('；')}`)
  const okText = ok.map((r) => `${r.summary}（#${r.eventId}）`).join('；')
  const failText = failed.map((f) => `${f.label}（${f.message}）`).join('；')
  return { type: 'receipt', text: `已生效 ${ok.length} 项：${okText}${failed.length ? `。失败 ${failed.length} 项：${failText}` : ''}` }
}

/** 单条建议的校验 + 落事件 + 立即生效。校验失败/生效守卫抛中文 Error。 */
function applySuggestion(db, payload, ctx) {
  const milestoneId = Number(payload.targetMilestoneId)
  if (milestoneId) return applyMilestoneSuggest(db, payload, ctx, milestoneId) // S35：里程碑改期/状态
  const taskId = Number(payload.targetTaskId)
  const task = taskId
    ? db.prepare('SELECT t.id, t.title, t.project_id AS pid, p.status AS project_status FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = ? AND t.deleted_at IS NULL').get(taskId)
    : null
  if (!task) throw new Error('targetTaskId 必填且须为真实任务 id（先 query 查任务）')
  if (task.project_status === 'closed' || task.project_status === 'cancelled') throw new Error('项目已结项/取消，任务面只读')
  if (payload.projectId !== undefined && payload.projectId !== null && Number(payload.projectId) !== task.pid) {
    throw new Error('任务不属于该项目')
  }
  const field = String(payload.targetField || '')
  if (!(field in SUGGEST_FIELDS)) throw new Error('targetField 仅支持 status / plan_start_date / plan_end_date / responsible_member_id')
  let value = payload.targetValue
  let valueLabel
  if (field === 'status') {
    value = assertValue('taskStatus', String(value))
    valueLabel = label('taskStatus', value)
  } else if (field === 'plan_start_date' || field === 'plan_end_date') {
    if (!DATE_RE.test(String(value))) throw new Error('日期值须为 YYYY-MM-DD（按今天自己换算）')
    valueLabel = String(value)
  } else {
    value = Number(value)
    const m = db.prepare(`SELECT id, name FROM members WHERE id = ? AND status = 'active'`).get(value)
    if (!m) throw new Error('责任人须为在职成员 id（先 query 查成员）')
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
  confirmEvent(db, evt.id, ctx.member.id) // K25：落库即生效（发令人=生效人；守卫失败抛错，pending 事件留痕可补救）
  return { eventId: evt.id, summary: evt.summary }
}

// S35：里程碑建议——建议通道扩展到里程碑（target_object='milestone'，生效走 events.applyMilestonePatch）。
// v0.46/K25：与任务建议同口径直改（任意已绑定成员可发起）；plan_date 改期 / status 达成·延误·取消（met 落实际日期）。
const MILESTONE_FIELDS = { plan_date: 'schedule_change', status: 'status_change' }

function applyMilestoneSuggest(db, payload, ctx, milestoneId) {
  const ms = db
    .prepare('SELECT m.id, m.name, m.project_id AS pid, p.status AS project_status FROM milestones m JOIN projects p ON p.id = m.project_id WHERE m.id = ?')
    .get(milestoneId)
  if (!ms) throw new Error('targetMilestoneId 必填且须为真实里程碑 id（先 query 查里程碑）')
  if (ms.project_status === 'closed' || ms.project_status === 'cancelled') throw new Error('项目已结项/取消，任务面只读')
  if (payload.projectId !== undefined && payload.projectId !== null && Number(payload.projectId) !== ms.pid) {
    throw new Error('里程碑不属于该项目')
  }
  const field = String(payload.targetField || '')
  if (!(field in MILESTONE_FIELDS)) throw new Error('targetField 仅支持 plan_date / status')
  let value = payload.targetValue
  let valueLabel
  if (field === 'plan_date') {
    if (!DATE_RE.test(String(value))) throw new Error('日期值须为 YYYY-MM-DD（按今天自己换算）')
    valueLabel = String(value)
  } else {
    try {
      value = assertValue('milestoneStatus', String(value))
      valueLabel = label('milestoneStatus', value)
    } catch {
      throw new Error('状态值须为 planned / met / missed / cancelled')
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
  confirmEvent(db, evt.id, ctx.member.id)
  return { eventId: evt.id, summary: evt.summary }
}

/**
 * S69（v0.80，K64）：常态项目每日打卡——人的明确指令直接生效并回执（K25；打卡=记录型事件，不设确认卡）。
 * 任务定位：taskId 精确，或 taskTitle/taskHint 标题精确→子串包含（命中须唯一，多义拒并列候选）；
 * day 缺省今天（北京日，可补过去、拒未来）；status done=完成 / skip=跳过 / pending=重置未做；
 * 一条指令多项打卡用 items 批量（≤20，逐条生效、汇总回执单列失败原因，与 suggest_event 同构）。
 */
function writeCheckinTask(db, payload, ctx) {
  const items = Array.isArray(payload.items) ? payload.items : [payload]
  if (!items.length) return refused('items 不能为空（单条打卡直接给 taskId/taskTitle + status）')
  if (items.length > 20) return refused('一条指令批量打卡至多 20 条')
  if (items.length === 1) {
    const r = applyCheckin(db, items[0], payload, ctx) // 校验/生效失败抛中文 Error → runWriteTool 转 refused
    return { type: 'receipt', text: `已打卡：${r.text}。` }
  }
  const ok = []
  const failed = []
  for (const item of items) {
    try {
      ok.push(applyCheckin(db, item, payload, ctx).text)
    } catch (e) {
      failed.push(`${item.taskId ? `任务 #${item.taskId}` : `「${item.taskTitle || item.taskHint || '?'}」`}（${e.message}）`)
    }
  }
  if (!ok.length) return refused(`批量打卡全部失败：${failed.join('；')}`)
  return { type: 'receipt', text: `已打卡 ${ok.length} 项：${ok.join('；')}${failed.length ? `。失败 ${failed.length} 项：${failed.join('；')}` : ''}` }
}

/** 单条打卡的定位 + 生效。校验失败/生效守卫抛中文 Error。 */
function applyCheckin(db, item, payload, ctx) {
  const projectId = Number(item.projectId ?? payload.projectId) || scopedProjectId(db, ctx.evt)
  const project = projectId ? db.prepare('SELECT id, name, kind FROM projects WHERE id = ?').get(projectId) : null
  if (!project) throw new Error('打卡需要明确项目：请给 projectId，或在项目专题群里 @我 打卡（专题群默认落到本群项目）')
  if (project.kind !== 'routine') throw new Error('打卡仅常态项目可用（该项目是交付项目，S69）')
  const taskId = Number(item.taskId)
  // 定位：taskId 精确；否则按任务名（精确→子串包含，命中须唯一）——零命中/多义抛中文 Error
  const task = Number.isInteger(taskId) && taskId > 0
    ? (() => {
        const row = db.prepare(`SELECT id, title FROM tasks WHERE id = ? AND project_id = ? AND kind = 'routine' AND deleted_at IS NULL`).get(taskId, project.id)
        if (!row) throw new Error('taskId 须为该项目的常态任务（先 query 查任务清单）')
        return row
      })()
    : findRoutineTaskByHint(db, project.id, item.taskTitle ?? item.taskHint)
  const day = item.day ?? payload.day
  const out = setDayStatus(db, {
    projectId: project.id, taskId: task.id,
    day: day == null || day === '' ? today() : String(day),
    status: item.status ?? 'done', note: item.note,
  }, ctx.member.id, { origin: 'bot', sourcePlatform: ctx.sourcePlatform })
  const statusLabel = { done: '完成', skip: '跳过', pending: '重置为未做' }[out.status] || out.status
  return { text: `任务「${task.title}」${out.day} ${statusLabel}${out.note ? `（${out.note}）` : ''}` }
}


function writeBindChannel(db, payload, ctx) {
  if (ctx.evt?.chatType !== 'group') return refused('群登记只在群聊里可用')
  const projectId = Number(payload.projectId)
  const project = projectId ? db.prepare('SELECT id, name, lead_member_id FROM projects WHERE id = ?').get(projectId) : null
  if (!project) return refused('projectId 必填且须为真实项目 id（先 query 查项目）')
  if (ctx.member.role !== 'admin' && project.lead_member_id !== ctx.member.id) {
    return refused('只有该项目的牵头人或系统管理员可以登记群，请 TA 来 @我登记', 'refused_permission')
  }
  // v0.46/K25：直写不再出确认卡。新建绑定 cursor=登记时刻（只抽登记之后的聊天）；既有绑定更新保留游标（S3-6/v0.24 口径不变）
  upsertChannel(db, {
    platform: ctx.evt?.platform || 'feishu', groupKey: ctx.evt.chatId,
    name: String(payload.chatName || ctx.evt.chatTitle || '') || null, channelType: 'dedicated', projectId: project.id,
  }, ctx.member.id)
  return { type: 'receipt', text: `本群已绑定为项目「${project.name}」的专题渠道，从现在开始定时抽取归档（不回灌历史）。` }
}

/** S61（v0.66，K45）：把一条内容记录到项目绑定的飞书知识库页面（用户「记一下」类指令）。
 *  原文护栏（用户 2026-10-10 拍板）：记到文档=原文存档，禁止 LLM 浓缩丢信息。
 *  LLM 只负责抠原文；若 summary 明显短于用户消息原文（浓缩信号），用抠掉触发前缀后的原文兜底。 */
async function writeRecordWiki(db, payload, ctx) {
  const projectId = Number(payload.projectId)
  const project = projectId ? db.prepare('SELECT id, name FROM projects WHERE id = ?').get(projectId) : null
  if (!project) return refused('projectId 必填且须为真实项目 id（先 query 查项目）')
  let summary = String(payload.summary || '').trim()
  if (!summary) return refused('要记录的内容不能为空')
  // 浓缩护栏：用户消息原文抠掉触发前缀（「记一下/记到文档里/写到知识库」等）后，
  // 若 LLM 给的 summary 明显更短（<60% 原文长度），判定为浓缩丢信息，用原文兜底
  const raw = String(ctx.evt?.text || '').trim()
  if (raw) {
    const verbatim = raw.replace(/^@\S+\s*/, '').replace(/^(记一下|记到文档里?|写到知识库|记录一下|帮我记|存档)[:：，,]?\s*/, '').trim()
    if (verbatim && summary.length < verbatim.length * 0.6) summary = verbatim
  }
  const eventType = String(payload.eventType || 'progress')
  // S62（v0.67，K47）：未绑定时——有默认父页面则出确认卡（新建子页+绑定+写入一步到位）；无则引导式拒绝
  const { getProjectWiki, getDefaultParentToken } = await import('../../engine/wiki.js')
  if (!getProjectWiki(db, project.id)) {
    if (getDefaultParentToken(db)) {
      const prop = createProposal(db, {
        kind: 'record_wiki_newpage',
        payload: { projectId: project.id, eventType, summary, newTitle: project.name },
        summary: `项目「${project.name}」未绑定知识库页面，确认后将在默认父页面下新建《${project.name}》并记录本条内容`,
        proposedBy: ctx.member.id,
      })
      return { type: 'card', cardKind: 'propose', proposalId: prop.id, kind: 'record_wiki_newpage', summary: prop.summary }
    }
    return refused('该项目还未绑定知识库页面。绑定方式：① 把 wiki 页面链接发给我（「绑定这个页面 https://…/wiki/…」）；② 或在 web 项目详情页「知识库」卡绑定。绑定后再说「记一下…」即可写入。')
  }
  try {
    const r = await recordToWiki(db, project.id, { eventType, summary }, ctx.member.id)
    return { type: 'receipt', text: `已记到项目「${project.name}」的知识库页面《${r.title || '未命名'}》（${r.section} 小节）✓\n📄 ${r.url}` }
  } catch (e) {
    return refused(e.message) // 权限不足/页面被删 → 明确中文回执
  }
}

/** S61（v0.66，K45）：绑定项目到知识库页面（贴链接，或在指定页面下新建子页）。仅牵头人/管理员。
 *  S70（v0.82，K66）：只给 newTitle 不给父页时回落默认父页面（明确新建指令直生效，K25——与 K47
 *  「记一下」隐含建页走确认卡是两档语义）；未配默认父页维持引导式拒绝。 */
async function writeBindWiki(db, payload, ctx) {
  const projectId = Number(payload.projectId)
  const project = projectId ? db.prepare('SELECT id, name, lead_member_id FROM projects WHERE id = ?').get(projectId) : null
  if (!project) return refused('projectId 必填且须为真实项目 id（先 query 查项目）')
  if (ctx.member.role !== 'admin' && project.lead_member_id !== ctx.member.id) {
    return refused('只有该项目的牵头人或系统管理员可以绑定知识库，请 TA 来操作', 'refused_permission')
  }
  let bindArgs = { wikiUrl: payload.wikiUrl, parentWikiUrl: payload.parentWikiUrl, newTitle: payload.newTitle }
  let viaDefaultParent = false
  if (!payload.wikiUrl && !payload.parentWikiUrl && !payload.parentNodeToken) {
    if (!payload.newTitle) {
      return refused('绑定知识库需要更多信息：把要绑定的页面链接发我，或说「新建一个项目飞书页」（配置了知识库默认父页面时我会自动挂载）。')
    }
    const parentToken = getDefaultParentToken(db)
    if (!parentToken) {
      return refused('新建子页需要父页面：把父页面的飞书 wiki 链接一并发我（如「父页面 https://xxx.feishu.cn/wiki/xxx，新建一个项目页」），或让管理员在配置台「外部依赖→知识库默认父页面」配置后直接说「新建一个项目飞书页」。')
    }
    bindArgs = { parentNodeToken: parentToken, newTitle: payload.newTitle }
    viaDefaultParent = true
  }
  try {
    const b = await bindProjectWiki(db, project.id, bindArgs, ctx.member.id)
    return {
      type: 'receipt',
      text: viaDefaultParent
        ? `项目「${project.name}」已在默认父页面下新建并绑定知识库页面《${b.title || '未命名'}》，之后说「记一下…」我就会写进去。`
        : `项目「${project.name}」已绑定知识库页面《${b.title || '未命名'}》，之后说「记一下…」我就会写进去。`,
    }
  } catch (e) {
    return refused(e.message)
  }
}

// —— S70（v0.82，K66）：新群快速立项——一条链 建项目→绑群→默认父页建知识页（best-effort 不阻塞）——

/** 可用项目类型清单（类型缺失拒绝时列候选，不猜）。 */
function activeTypeList(db) {
  return db.prepare(`SELECT code, name FROM project_types WHERE status = 'active' ORDER BY id`).all()
    .map((t) => `${t.code}=${t.name}`).join('、')
}

/** 从默认父页 URL 提取 host（回执链接用；解析失败兜底 feishu.cn）。 */
function hostOf(url) {
  try { return new URL(url).host } catch { return 'feishu.cn' }
}

/**
 * 快速立项核心（/init 斜杠与 write quick_create_project 共用，K66）。
 * payload: { name?（缺省=群名）, typeCode?（缺省=projects.quickCreateTypeCode） }。
 * 缺省规则：项目名=群名（evt.chatTitle，缺失时连接器 getChat 回拉）、牵头人=发起人
 * （天然满足 createProject「管理员或拟任牵头人本人」权限矩阵）；类型解析不出则拒绝并列候选。
 * 信任边界（K25）：对话面明确指令直接生效；知识页 best-effort——失败不阻塞立项与绑群。
 */
export async function runQuickCreate(db, payload = {}, ctx = {}) {
  const evt = ctx.evt || {}
  const platform = evt.platform || ctx.sourcePlatform || 'feishu'
  if (evt.chatType !== 'group') return refused('快速立项只在群聊里可用——在新项目群里 @我 发 /init [类型码]。')

  // 群名解析：chatTitle（网关带入）→ 连接器 getChat 回拉 → 明确报错
  let groupName = evt.chatTitle || null
  if (!groupName) {
    try {
      const chat = await CHAT_CONNECTORS[platform]?.getChat?.(getSetting(db, `im.${platform}`), evt.chatId)
      groupName = chat?.name || null
    } catch { /* 保持 null，走报错 */ }
  }
  const name = String(payload.name || groupName || '').trim()
  if (!name) {
    return refused('拿不到本群的群名（飞书接口失败或未授权），无法以群名立项——请稍后重试，或改用自然语言告诉我项目名（「建个项目，名字叫 XX」）。')
  }

  // 守卫：群已是专题渠道 → 拒绝（防误绑重绑）
  const existing = db.prepare(
    'SELECT c.channel_type, c.project_id, p.name AS project_name FROM channels c LEFT JOIN projects p ON p.id = c.project_id WHERE c.platform = ? AND c.group_key = ?'
  ).get(platform, evt.chatId)
  if (existing?.channel_type === 'dedicated') {
    return refused(`本群已绑定为项目「${existing.project_name || `#${existing.project_id}`}」的专题渠道，不能在此快速立项。要建新项目，请把我拉进一个新群再发 /init。`)
  }

  // 类型解析：参数 → 全局默认 → 拒绝列候选（不猜）
  const code = String(payload.typeCode || getSetting(db, 'projects').quickCreateTypeCode || '').trim()
  if (!code) {
    return refused(`快速立项需要项目类型：重发「/init <类型码>」，或让管理员在配置台「外部依赖→快速立项默认类型」配置全局默认。可用类型：${activeTypeList(db)}`)
  }
  const type = db.prepare(`SELECT code, name FROM project_types WHERE code = ? AND status = 'active'`).get(code)
  if (!type) {
    return refused(`项目类型 ${code} 不存在或已停用。可用类型：${activeTypeList(db)}`)
  }

  // ① 建项目（任务按类型清单实例化；立项事件+审计在引擎内）
  let proj
  try {
    proj = createProject(db, { name, typeCode: type.code, leadMemberId: ctx.member.id }, ctx.member.id)
  } catch (e) {
    return refused(`立项失败：${e.message}`)
  }

  // ② 绑群为专题渠道（cursor=当前时刻，不回灌历史；群名回填渠道名）
  upsertChannel(db, { platform, groupKey: evt.chatId, name: groupName || name, channelType: 'dedicated', projectId: proj.id }, ctx.member.id)

  // ③ 默认父页下建知识页并绑定（best-effort：失败不阻塞，回执单列原因）
  let wikiLine
  try {
    const parentToken = getDefaultParentToken(db)
    if (!parentToken) {
      wikiLine = '知识页未建：未配置默认父页面（管理员在配置台「外部依赖→知识库默认父页面」配置后，说「新建一个项目飞书页」即可补建）'
    } else {
      const b = await bindProjectWiki(db, proj.id, { parentNodeToken: parentToken, newTitle: proj.name }, ctx.member.id)
      wikiLine = `知识页：已在默认父页面下新建《${b.title || proj.name}》 → ${wikiPageUrl(b.nodeToken, hostOf(getSetting(db, 'wiki').defaultParentUrl))}`
    }
  } catch (e) {
    wikiLine = `知识页未建：${e.message}`
  }

  const taskCount = db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND deleted_at IS NULL').get(proj.id).n
  return {
    type: 'receipt',
    result: 'replied',
    text: `快速立项完成 ✓\n· 项目「${proj.name}」（#${proj.id}，类型 ${type.name}，牵头人 ${ctx.member.name}）\n· 任务按类型清单实例化 ${taskCount} 项——可对我说「初始分配一下」补责任人与排期\n· ${wikiLine}\n· 本群已绑定为项目专题渠道（从现在开始定时抽取归档，不回灌历史）`,
  }
}

// —— S25（v0.17）项目级/配置级操作：v0.46/K25 分流——终态操作（取消/结项）走「提议→确认卡→生效」； ——
// —— 其余 kind 软校验 + 发起人权限前置（canConfirm 复用为执行校验）后直写既有 engine，回执已生效 ——

/** 确认卡只留删除级终态操作（用户 2026-10-09 拍板：只有删除动作做确认）。 */
const CARD_KINDS = new Set(['cancel_project', 'close_project'])

const normTasks = (tasks) => (Array.isArray(tasks) ? tasks : []).map((t) => (typeof t === 'string' ? { title: t } : t)).filter((t) => t && t.title)

/** S33：提议载荷里的任务参考提前校验（复用引擎归一；直写时引擎再兜底校验一次）。 */
const checkTaskRefs = (tasks) => {
  try {
    normalizeTypeTasks(tasks.map((t) => (typeof t === 'string' ? { title: t } : t)))
    return ''
  } catch (e) {
    return e.message
  }
}
const DATE_OK = /^\d{4}-\d{2}-\d{2}$/

async function writePropose(db, payload, ctx) {
  const kind = String(payload?.kind || '')
  if (!PROPOSAL_KINDS[kind]) return refused(`不支持的提议类型: ${kind}（可用 ${Object.keys(PROPOSAL_KINDS).join(' / ')}）`)
  const check = softValidateProposal(db, kind, payload)
  if (check.error) return refused(check.error)
  if (CARD_KINDS.has(kind)) {
    const prop = createProposal(db, { kind, payload: check.payload, summary: check.summary, proposedBy: ctx.member.id })
    return { type: 'card', cardKind: 'propose', proposalId: prop.id, kind, summary: prop.summary }
  }
  // 直写：原确认矩阵前置为发起人执行权限校验（谁能确认 = 谁能直接执行，权限模型不变只少一步点按）
  const spec = PROPOSAL_KINDS[kind]
  const allowed = await spec.canConfirm(db, ctx.member, check.payload)
  if (allowed !== true) throw allowed // 403 → runWriteTool 转 refused_permission
  // S35-7（v0.74，K25 修订）：add_task tasks[] 批量——与 suggest_event items 同构（批量在一个 write 内表达，
  // agent 循环「写即终止」不变）：逐条独立生效、一条汇总回执单列失败原因（best-effort，不整体回滚）
  if (check.items) {
    const ok = []
    const failed = []
    for (const item of check.items) {
      if (item.error) {
        failed.push(`「${item.title}」（${item.error}）`)
        continue
      }
      try {
        await spec.apply(db, item.payload, ctx.member.id)
        ok.push(item.summary)
      } catch (e) {
        failed.push(`「${item.title}」（${e.message}）`)
      }
    }
    if (!ok.length) return refused(`批量建任务全部失败：${failed.join('；')}`)
    const failText = failed.length ? `。失败 ${failed.length} 项：${failed.join('；')}` : ''
    return { type: 'receipt', text: `已生效 ${ok.length} 项：${ok.join('；')}${failText}` }
  }
  await spec.apply(db, check.payload, ctx.member.id)
  return { type: 'receipt', text: `已生效：${check.summary}。` }
}

function getProj(db, id) {
  return Number(id) ? db.prepare('SELECT id, name, kind, status, lead_member_id, plan_end_date FROM projects WHERE id = ?').get(Number(id)) : null
}

/** add_task 单条字段软校验（单条/批量共用；硬校验在引擎生效时兜底）。返回 { payload, summary, title } 或 { error }。 */
function validateTaskFields(db, proj, item) {
  const title = String(item.title || '').trim()
  if (!title) return { error: 'title 必填（任务标题）' }
  // S57：任务备注（软校验，硬校验在引擎 400 兜底）
  if (item.note != null && (typeof item.note !== 'string' || !item.note.trim() || item.note.length > 200)) {
    return { error: 'note 须为 ≤200 字的非空字符串（可省略）' }
  }
  let owner = null
  if (item.responsibleMemberId != null) {
    owner = db.prepare(`SELECT id, name FROM members WHERE id = ? AND status = 'active'`).get(Number(item.responsibleMemberId))
    if (!owner) return { error: '责任人不存在或已离职（先 query 查成员）' }
  }
  // S69（K64）：常态项目——任务一律常态分类（kind=routine，无 work/reminder/排期语义），可带适用星期（缺省每天）
  if (proj.kind === 'routine') {
    if (item.taskKind != null && item.taskKind !== 'routine') {
      return { error: '常态项目的任务一律为常态分类（无需 taskKind，也无 work/reminder 语义，S69）' }
    }
    if (item.planStartDate || item.planEndDate) return { error: '常态任务无计划起止（每日执行走周视图打卡，S69）' }
    let weekdays
    try {
      weekdays = item.weekdays === undefined ? undefined : normalizeWeekdays(item.weekdays)
    } catch (e) {
      return { error: e.message }
    }
    const wd = weekdays ?? [1, 2, 3, 4, 5, 6, 7]
    return {
      payload: {
        projectId: proj.id, title: title.slice(0, 200), taskKind: 'routine', weekdays: wd,
        ...(item.note ? { note: String(item.note).trim() } : {}),
        ...(owner ? { responsibleMemberId: owner.id } : {}),
      },
      summary: `项目「${proj.name}」新增常态任务「${title.slice(0, 200)}」（${weekdaysLabel(wd)}${owner ? `，责任人 ${owner.name}` : ''}）`,
      title: title.slice(0, 50),
    }
  }
  // S57：任务分类（taskKind——payload.kind 是提议类型判别符，不可复用）
  if (item.taskKind != null && item.taskKind !== 'work' && item.taskKind !== 'reminder') return { error: 'taskKind 须为 work（工作，缺省）或 reminder（纯提醒）' }
  if (item.taskKind === 'routine') return { error: '常态任务只能建在常态项目（S69）' }
  if (item.taskKind === 'reminder' && !item.planEndDate) return { error: '纯提醒任务必须给 planEndDate（提醒日 YYYY-MM-DD，到期推责任人+项目群后自动完成）' }
  if (item.planStartDate && !DATE_OK.test(String(item.planStartDate))) return { error: 'planStartDate 须为 YYYY-MM-DD' }
  if (item.planEndDate && !DATE_OK.test(String(item.planEndDate))) return { error: 'planEndDate 须为 YYYY-MM-DD' }
  return {
    payload: {
      projectId: proj.id, title: title.slice(0, 200),
      ...(item.taskKind ? { taskKind: String(item.taskKind) } : {}),
      ...(item.note ? { note: String(item.note).trim() } : {}),
      ...(owner ? { responsibleMemberId: owner.id } : {}),
      ...(item.planStartDate ? { planStartDate: String(item.planStartDate) } : {}),
      ...(item.planEndDate ? { planEndDate: String(item.planEndDate) } : {}),
    },
    summary: `项目「${proj.name}」新增${item.taskKind === 'reminder' ? '纯提醒' : '任务'}「${title.slice(0, 200)}」（责任人 ${owner ? owner.name : '未指派'}${item.planEndDate ? `，${item.taskKind === 'reminder' ? '提醒日' : '截止'} ${item.planEndDate}` : ''}${item.note ? '，带备注' : ''}）`,
    title: title.slice(0, 50),
  }
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
    // S69：常态项目手动结项豁免「全部任务完成」（常态任务永不 done）；交付项目维持 S8 校验提示
    if (proj.kind === 'routine') {
      return {
        payload: { projectId: proj.id, summary: summaryText.slice(0, 200) },
        summary: `项目「${proj.name}」结项：${summaryText}（常态项目：手动结项豁免任务完成检查，S69）`,
      }
    }
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
    const refErr = checkTaskRefs(tasks) // S33：带 refs 的任务项提前校验（引擎生效时兜底）
    if (refErr) return { error: refErr }
    const autoSchedule = p.autoSchedule === true
    if (autoSchedule && !p.planEndDate) return { error: 'autoSchedule 倒排须同时给 planEndDate（交付日期，YYYY-MM-DD）' }
    return {
      payload: {
        name: String(p.name).trim().slice(0, 100), typeCode: p.typeCode ? String(p.typeCode) : undefined,
        templateCode: p.templateCode ? String(p.templateCode) : undefined, leadMemberId: lead.id,
        ...(p.priority ? { priority: String(p.priority) } : {}), ...(p.clientName ? { clientName: String(p.clientName) } : {}),
        ...(p.planStartDate ? { planStartDate: String(p.planStartDate) } : {}), ...(p.planEndDate ? { planEndDate: String(p.planEndDate) } : {}),
        ...(p.initExtra ? { initExtra: String(p.initExtra) } : {}), // S64：项目级初始分配补充要求透传（引擎生效时校验）
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
    const refErr = checkTaskRefs(tasks) // S33：类型模板步骤可挂参考链接（提前校验，引擎生效时兜底）
    if (refErr) return { error: refErr }
    return {
      payload: {
        code: String(p.code), name: String(p.name), ...(p.description ? { description: String(p.description) } : {}),
        ...(p.initPrompt ? { initPrompt: String(p.initPrompt) } : {}), // S39：初始化提示词透传（引擎生效时校验）
        tasks,
      },
      summary: `新建项目类型「${p.name}」（${p.code}，内嵌任务 ${tasks.length} 项${tasks.reduce((s, t) => s + ((t.refs ?? []).length), 0) ? `，参考资料 ${tasks.reduce((s, t) => s + ((t.refs ?? []).length), 0)} 条` : ''}）`,
    }
  }
  // —— S35 项目维护面：建任务 / 建里程碑 / 项目信息变更（软校验，硬校验在引擎生效时兜底）——
  // S35-7（v0.74）：add_task 支持 tasks[] 批量（≤20 条，title 可为纯字符串，字段同单条）；
  // 逐条软校验（坏条目不阻塞其余，生效时在汇总回执单列原因），单条形态与原行为完全一致。
  if (kind === 'add_task') {
    const proj = getProj(db, p.projectId)
    if (!proj) return { error: 'projectId 必填且须为真实项目 id（先 query 查项目）' }
    const batch = Array.isArray(p.tasks)
    const rawItems = batch ? p.tasks.map((t) => (typeof t === 'string' ? { title: t } : (t && typeof t === 'object' ? t : {}))) : [p]
    if (batch && !rawItems.length) return { error: 'tasks 不能为空（单条建任务直接给 title）' }
    if (batch && rawItems.length > 20) return { error: '一条指令批量建任务至多 20 条' }
    const items = []
    for (const [i, item] of rawItems.entries()) {
      const one = validateTaskFields(db, proj, item)
      if (one.error) {
        if (!batch) return { error: one.error }
        items.push({ title: String(item.title || '').trim().slice(0, 50) || `第 ${i + 1} 条`, error: one.error })
      } else {
        items.push(one)
      }
    }
    if (!batch) return { payload: items[0].payload, summary: items[0].summary }
    return {
      payload: { projectId: proj.id, tasks: items.filter((x) => x.payload).map((x) => x.payload) },
      items,
      summary: `项目「${proj.name}」批量新增任务 ${items.length} 项`,
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
  // S35-8（v0.76，K57）：按项目自身类型清单补任务——清单由引擎从库里拷，LLM 只传 projectId（不经转述，无 20 条护栏）；
  // 预算「待补 N / 跳过 M」写进回执摘要；守卫文案与引擎 planTypeTasks 同源（终态只读/无类型/无清单/全部已存在）。
  if (kind === 'apply_type_tasks') {
    const proj = getProj(db, p.projectId)
    if (!proj) return { error: 'projectId 必填且须为真实项目 id（先 query 查项目）' }
    let plan
    try {
      plan = planTypeTasks(db, proj.id)
    } catch (e) {
      return { error: e.message }
    }
    return {
      payload: { projectId: proj.id },
      summary: `项目「${proj.name}」按类型「${plan.type.name}」清单补建任务 ${plan.toAdd.length} 项${plan.skipped.length ? `（跳过已存在 ${plan.skipped.length} 项）` : ''}`,
    }
  }
  if (kind === 'update_project') {
    const proj = getProj(db, p.projectId)
    if (!proj) return { error: 'projectId 必填且须为真实项目 id（先 query 查项目）' }
    if ('status' in p) return { error: '项目状态仅可经结项/取消变更（S29）：请走 close_project / cancel_project 提议' }
    const KEYS = ['name', 'clientName', 'priority', 'planStartDate', 'planEndDate', 'leadMemberId', 'initExtra']
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
    if (!changes.length) return { error: '至少提供一个要变更的字段（name/clientName/priority/planStartDate/planEndDate/leadMemberId/initExtra）' }
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

// —— S64（v0.69，K49）：机器人触发 AI 初始分配（触发 + 确认卡人审，无直写）——

/** 专题群定域（与 morningScopeProjectId 同款查询）：本群绑定 dedicated 渠道才回落到该群项目。 */
function scopedProjectId(db, evt) {
  if (evt?.chatType !== 'group') return null
  const ch = db.prepare('SELECT channel_type, project_id FROM channels WHERE platform = ? AND group_key = ?')
    .get(evt.platform || 'feishu', evt.chatId)
  return ch?.channel_type === 'dedicated' ? ch.project_id : null
}

/** 后台推送的消息落 bot_reply（与 command.js recordReplyRow 同口径）：定时抽取跳过机器人自身消息的依据。 */
function recordBotReply(db, messageId, chatId, text, intent) {
  if (!messageId) return
  db.prepare(
    `INSERT OR IGNORE INTO bot_commands (message_id, platform, chat_id, chat_type, kind, raw_text, intent, created_at)
     VALUES (?, 'feishu', ?, NULL, 'bot_reply', ?, ?, ?)`
  ).run(messageId, chatId || null, text ? String(text).slice(0, 2000) : null, intent ?? null, Date.now())
}

/** 草案展示行：任务/责任人/计划起止（责任人 id → 姓名；标题截断防卡片撑爆）。 */
function assignmentRows(db, assignments) {
  const nameStmt = db.prepare('SELECT name FROM members WHERE id = ?')
  return assignments.map((a) => ({
    title: String(a.title ?? `#${a.taskId}`).slice(0, 30),
    owner: a.responsibleMemberId == null ? '未指派' : (nameStmt.get(a.responsibleMemberId)?.name || `#${a.responsibleMemberId}`),
    plan: `${a.planStartDate || '?'} ~ ${a.planEndDate || '?'}`,
  }))
}

/**
 * S64 机器人触发初始分配：口述要求提炼进 extra → 复用 S44 异步作业（带 onDone）→ 立即回执「生成中」；
 * 草案完成后由 onDone 落 init_assignments 提议（持久化 pending，卡片长期有效不受作业 TTL 限制）
 * 并把确认卡推回触发会话；任意已绑定成员点「确认应用」后 applyInitAssignments(platform='bot') 生效。
 * 404/409/503/400 由 startDraftInitAssignments 同步抛出 → runWriteTool 统一转 refused 中文文案。
 */
async function writeInitAssign(db, payload, ctx) {
  if (typeof ctx.push !== 'function') {
    return refused('初始分配触发仅 IM 会话可用——web 请用项目详情页「✨ AI 初始分配」，Agent 通道用 draft/apply_init_assignments')
  }
  const projectId = Number(payload.projectId) || scopedProjectId(db, ctx.evt)
  const project = projectId ? db.prepare('SELECT id, name, status FROM projects WHERE id = ?').get(projectId) : null
  if (!project) {
    return refused('初始分配需要明确项目：请给 projectId，或在项目专题群里 @我 触发（专题群默认落到本群项目）')
  }
  const { startDraftInitAssignments } = await import('../initAssign.js')
  const chatId = ctx.evt?.chatId
  const job = startDraftInitAssignments(db, project.id, {
    llm: ctx.llm ?? undefined,
    extra: payload.extra, // 归一在 startDraft 同步做（非法 → 400 → refused）
    onDone: (done) => {
      void pushInitAssignResult(db, done, {
        project, chatId, memberId: ctx.member.id, push: ctx.push, secret: ctx.botSecret,
      })
    },
  })
  return {
    type: 'receipt',
    text: `初始分配草案生成中（作业 ${job.draftId}，约 1-2 分钟）——完成后我会把草案卡片发到本会话，点「确认应用」后批量生效。${job.extra ? `\n本次追加要求：${job.extra}` : ''}`,
  }
}

/** 作业终态推送（onDone 回调，尽力而为不抛出）：done 有任务→提议+确认卡（失败降级文本）；
 *  done 无任务 / error → 文本提示；无签名密钥发不了卡 → 文本引导走 web。 */
async function pushInitAssignResult(db, job, { project, chatId, memberId, push, secret }) {
  const pushText = async (text) => {
    const sent = await push({ chatId, text })
    recordBotReply(db, sent?.messageId, chatId, text, 'write:init_assign')
  }
  try {
    if (job.status === 'error') {
      await pushText(`初始分配草案生成失败：${job.error}——请稍后重试；若持续失败请管理员检查 LLM 配置。`)
      return
    }
    if (!job.assignments?.length) {
      await pushText(`初始分配：${job.warnings?.[0] || '没有可分配任务'}——无需生成草案。`)
      return
    }
    const prop = createProposal(db, {
      kind: 'init_assignments',
      payload: { projectId: project.id, assignments: job.assignments, extra: job.extra ?? null },
      summary: `初始分配草案：项目「${project.name}」${job.assignments.length} 项任务的责任人与计划起止（确认后批量生效）`,
      proposedBy: memberId,
    })
    if (!secret) {
      await pushText(`初始分配草案已生成（提议 #${prop.id}，${job.assignments.length} 项）——本环境未配置卡片签名密钥，请在 web 项目详情页「AI 初始分配」确认应用。`)
      return
    }
    const cardDesc = `初始分配草案卡片（提议 #${prop.id}，${job.assignments.length} 项任务）`
    const card = buildInitAssignCard({
      proposalId: prop.id, projectName: project.name,
      rows: assignmentRows(db, job.assignments), warnings: job.warnings || [], extra: job.extra ?? null,
    }, secret)
    let sent
    try {
      sent = await push({ chatId, card })
    } catch {
      sent = await push({ chatId, text: `初始分配草案已生成（提议 #${prop.id}，${job.assignments.length} 项）——卡片发送失败，请在 web 项目详情页「AI 初始分配」确认应用。` })
    }
    recordBotReply(db, sent?.messageId, chatId, cardDesc, 'write:init_assign')
  } catch (e) {
    try { await pushText(`初始分配草案推送失败：${e.message}`) } catch { /* 尽力而为 */ }
  }
}

// —— S73（v0.85，K69）：机器人触发「生成项目汇总」——S64 异步回执模式复用 ——

/** 终态推送（onDone 回调，尽力而为不抛出）：done 带页面链接与回读消息数；failed 带台账中文错误。 */
async function pushWikiArchiveResult(db, run, { project, chatId, push }) {
  try {
    const text = run.status === 'done'
      ? `项目「${project.name}」汇总已生成 ✓（回读群消息 ${run.messageCount} 条${run.truncated ? '，超上限已截断/抽样，仅含最近部分' : ''}）\n📄 ${run.pageUrl}`
      : `项目「${project.name}」汇总生成失败：${run.error}——可稍后重试（重跑会原位替换上次生成区，不会叠加）。`
    const sent = await push({ chatId, text })
    recordBotReply(db, sent?.messageId, chatId, text, 'write:wiki_archive')
  } catch { /* 尽力而为：推送失败不影响台账终态（S73-2） */ }
}

/**
 * S73 机器人触发项目汇总归档：专题群自动定域（scopedProjectId 同 init_assign）+ 权限与 web
 * 路由同口径（canManageChannel：仅系统管理员或项目牵头人）+ 复用 startWikiArchive（S72 常态守卫/
 * 前置校验/幂等替换全不变，400/409 中文文案原样透传）；立即回执「生成中」，完成后终态推送回本会话。
 * web AI 助手无 push 能力 → 指引项目详情页按钮（与 init_assign 同口径）。
 */
async function writeWikiArchive(db, payload, ctx) {
  if (typeof ctx.push !== 'function') {
    return refused('生成项目汇总仅 IM 会话可用——web 请用项目详情页知识库卡的「生成项目汇总」按钮')
  }
  const projectId = Number(payload.projectId) || scopedProjectId(db, ctx.evt)
  const project = projectId ? db.prepare('SELECT id, name, status FROM projects WHERE id = ?').get(projectId) : null
  if (!project) {
    return refused('生成项目汇总需要明确项目：请给 projectId，或在项目专题群里 @我 触发（专题群默认落到本群项目）；也可在 web 项目详情页点「生成项目汇总」')
  }
  if (!canManageChannel(db, ctx.member, { channelType: 'dedicated', projectId: project.id })) {
    return refused('仅系统管理员或项目牵头人可生成项目汇总，请 TA 来 @我 触发', 'refused_permission')
  }
  const chatId = ctx.evt?.chatId
  let run
  try {
    const { startWikiArchive } = await import('../../engine/wikiArchive.js')
    run = await startWikiArchive(db, project.id, ctx.member.id, {
      llm: ctx.llm ?? undefined,
      onDone: (done) => { void pushWikiArchiveResult(db, done, { project, chatId, push: ctx.push }) },
    })
  } catch (e) {
    return refused(e.message) // 400/409 前置校验中文文案原样透传（常态守卫/未绑页面/未绑群/运行中），不落台账
  }
  return { type: 'receipt', text: `项目「${project.name}」汇总生成中（任务 #${run.id}，全量回读本群历史，约需几分钟）——完成后我把结果发到这里。` }
}

// —— S74（v0.86，K71）：机器人结项一条链——免理由 + 自动补项目汇总 + 群内步骤播报 ——

/** 终态通知文案：任务盘子 + 汇总链接（若有）+ 可解散本群提示与祝福。 */
function closeChainFinalText(db, project, pageUrl, messageCount) {
  const n = db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND deleted_at IS NULL').get(project.id).n
  return [
    `🎉 项目「${project.name}」已结项 ✓`,
    `· ${project.kind === 'routine' ? `常态项目 ${n} 项任务收尾归档` : `全部 ${n} 项任务已完成`}`,
    ...(pageUrl ? [`· 项目汇总已归档：📄 ${pageUrl}${messageCount != null ? `（回读群消息 ${messageCount} 条）` : ''}`] : []),
    '本群使命完成，可以解散了——祝大家下次项目依然顺利！',
  ].join('\n')
}

/**
 * 结项收口：总结自动组装（口述 > 汇总链接 > 兜底文案）→ closeProject → 终态通知文案。
 * 引擎 closeProject 契约不变（web 面仍必填总结；本链总给得出非空文本）。
 */
async function finalizeClose(db, { project, payload, ctx, pageUrl, messageCount }) {
  const oral = String(payload.summary || '').trim().slice(0, 200)
  const summary = oral
    || (pageUrl ? `项目群全量汇总已归档：${pageUrl}` : `项目结项（群内 @机器人 结项，${today()}，未附总结）`)
  await closeProject(db, project.id, { summary }, ctx.member.id)
  return closeChainFinalText(db, project, pageUrl, messageCount)
}

/** 汇总完成后的续链（onDone 回调，尽力而为不抛出）：成功→播报②并结项+终态通知；失败→中止并指路。 */
async function closeAfterArchive(db, run, { project, payload, ctx, pushText }) {
  try {
    if (run.status === 'done') {
      await pushText(`① 项目汇总已生成 ✓（回读群消息 ${run.messageCount} 条）\n📄 ${run.pageUrl}\n→ ② 正在结项…`)
      const finalText = await finalizeClose(db, { project, payload, ctx, pageUrl: run.pageUrl, messageCount: run.messageCount })
      await pushText(`② 结项完成 ✓\n${finalText}`)
    } else {
      await pushText(`① 项目汇总生成失败：${run.error}\n已中止结项（项目保持进行中）。可稍后重试，或对我说「直接结项」跳过汇总立即结项。`)
    }
  } catch (e) {
    try { await pushText(`结项链执行失败：${e.message}——项目状态未变，可重试`) } catch { /* 尽力而为 */ }
  }
}

/**
 * S74 机器人结项一条链：权限（仅牵头人/管理员）→ 终态/S8 前置校验（不白跑汇总）→
 * 绑页未归档的交付项目先自动补「生成项目汇总」（S73 onDone 链，群内播报步骤）→ 自动结项
 * （总结免填自动组装）→ 终态通知（可解散本群+祝福）。常态项目/未绑页/未绑群/已归档/skipSummary
 * 跳过①直接结项。web 会话（无 push）回落既有 propose 确认卡口径（S25/S29 不变）。
 */
async function writeCloseProject(db, payload, ctx) {
  if (typeof ctx.push !== 'function') {
    return writePropose(db, { ...payload, kind: 'close_project' }, ctx)
  }
  const projectId = Number(payload.projectId) || scopedProjectId(db, ctx.evt)
  const project = projectId ? db.prepare('SELECT id, name, status, kind FROM projects WHERE id = ?').get(projectId) : null
  if (!project) {
    return refused('结项需要明确项目：请给 projectId，或在项目专题群里 @我 触发（专题群默认落到本群项目）')
  }
  if (!canManageChannel(db, ctx.member, { channelType: 'dedicated', projectId: project.id })) {
    return refused('仅系统管理员或项目牵头人可结项，请 TA 来 @我 触发', 'refused_permission')
  }
  if (project.status !== 'active') {
    return refused(`项目已是终态（${label('projectStatus', project.status)}），不可再结项（S29 终态不可逆）`)
  }
  // S8 前置：交付项目须全部任务完成（常态项目 S69 豁免）——提前拦，不白跑几分钟汇总
  if (project.kind !== 'routine') {
    const open = db.prepare(`SELECT title FROM tasks WHERE project_id = ? AND status != 'done' AND deleted_at IS NULL LIMIT 1`).get(project.id)
    if (open) {
      const total = db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND status != 'done' AND deleted_at IS NULL`).get(project.id).n
      return refused(`还有 ${total} 个未完成任务（如「${open.title}」），全部完成后方可结项（S8）——可让我逐项改完成后 结项，或先处理遗留项`)
    }
  }
  const chatId = ctx.evt?.chatId
  const pushText = async (text) => {
    const sent = await ctx.push({ chatId, text })
    recordBotReply(db, sent?.messageId, chatId, text, 'write:close_project')
  }
  // ①是否补汇总：绑定知识页 + 绑定专题群 + 从未成功归档 + 交付项目 + 未口述跳过
  const wantSummary = !payload.skipSummary && project.kind !== 'routine'
    && getProjectWiki(db, project.id)
    && db.prepare("SELECT 1 FROM channels WHERE project_id = ? AND platform = 'feishu' AND channel_type = 'dedicated' LIMIT 1").get(project.id)
    && !db.prepare("SELECT 1 FROM wiki_archive_runs WHERE project_id = ? AND status = 'done' LIMIT 1").get(project.id)
  if (wantSummary) {
    if (db.prepare("SELECT 1 FROM wiki_archive_runs WHERE project_id = ? AND status = 'running' LIMIT 1").get(project.id)) {
      return refused('项目已有正在运行的汇总任务，等它完成后再结项，或对我说「直接结项」跳过汇总立即结项')
    }
    let run
    try {
      const { startWikiArchive } = await import('../../engine/wikiArchive.js')
      run = await startWikiArchive(db, project.id, ctx.member.id, {
        llm: ctx.llm ?? undefined,
        onDone: (done) => { void closeAfterArchive(db, done, { project, payload, ctx, pushText }) },
      })
    } catch (e) {
      return refused(e.message) // 前置校验中文文案透传
    }
    return {
      type: 'receipt',
      text: `收到结项指令 ✓ 按步骤执行：\n① 生成项目汇总（全量回读本群历史，任务 #${run.id}，约几分钟）\n② 结项 → ③ 完成通知\n正在 ①——每步完成我都会在群里播报。`,
    }
  }
  // 无需①（已归档/未绑页或群/常态/直接结项）→ 同步直接结项，回执即终态通知
  try {
    const pageUrl = db.prepare("SELECT page_url FROM wiki_archive_runs WHERE project_id = ? AND status = 'done' ORDER BY id DESC LIMIT 1").get(project.id)?.page_url || null
    const finalText = await finalizeClose(db, { project, payload, ctx, pageUrl })
    return { type: 'receipt', text: finalText }
  } catch (e) {
    return refused(`结项失败：${e.message}`)
  }
}
