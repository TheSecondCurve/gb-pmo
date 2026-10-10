// 大脑·IM 抽取（S3）：专题渠道直接抽取；通用群先 LLM 分拣（低置信进未分拣池）。
// 信任边界：记录型自动生效；建议型（状态/日期/责任人）一律 pending 等人确认。

import { camelizeRows, camelizeRow } from '../db/index.mjs'
import { getSetting } from '../engine/settings.js'
import { addEvent, markPushedTo } from '../engine/events.js'
import { getLlm, parseJsonLoose } from './llm.js'
import { routeMessage } from './routing.js'
import { notifyMember, notifyAdmins } from './push.js'
import { acceptanceAlarm } from '../engine/metrics.js'
import * as feishu from './connectors/feishu.js'
import * as wecom from './connectors/wecom.js'

const CONNECTORS = { feishu, wecom }

/** 定时/按需触发入口（action 端点 / 调度器）：按渠道配置拉增量并抽取。 */
export async function runExtraction(db, { channelId, projectId } = {}, { llm, send } = {}) {
  const channels = camelizeRows(
    channelId
      ? db.prepare('SELECT * FROM channels WHERE id = ?').all(channelId)
      : db.prepare('SELECT * FROM channels').all()
  ).filter((c) => !projectId || c.channelType === 'general' || c.projectId === projectId)

  const results = []
  for (const ch of channels) {
    const cfg = getSetting(db, `im.${ch.platform}`)
    try {
      const { messages, nextCursor } = await CONNECTORS[ch.platform].fetchMessages(cfg, ch, ch.cursor)
      const ingested = await ingestMessages(db, ch, messages, { llm, send })
      db.prepare('UPDATE channels SET cursor = ?, last_pull_at = ? WHERE id = ?').run(nextCursor, Date.now(), ch.id)
      results.push({ channelId: ch.id, platform: ch.platform, pulled: messages.length, ...ingested })
    } catch (e) {
      results.push({ channelId: ch.id, platform: ch.platform, error: e.message })
    }
  }
  // S3-5：采纳率告警（周窗口低于阈值 → 告警管理员）
  const alarm = acceptanceAlarm(db)
  if (alarm) {
    await notifyAdmins(db, {
      pushType: 'alert',
      title: `大脑抽取采纳率低于阈值（${Math.round(alarm.rate * 100)}% < ${Math.round(alarm.threshold * 100)}%）`,
      body: `近 7 天生成建议 ${alarm.generated} 条，被采纳 ${alarm.accepted} 条。请在配置台调整抽取策略或阈值。`,
    }, { send })
    results.push({ acceptanceAlarm: alarm })
  }
  return { channels: results }
}

/**
 * 消息批量入库（测试直调；连接器喂数据的统一通道）。
 * 每条消息：身份映射 → （通用群）分拣 → LLM 抽取 → 事件写入。
 * S20-10：机器人已处理/已回复的消息（bot_commands 有 message_id）跳过，防同一消息双入库。
 */
export async function ingestMessages(db, channel, messages, { llm: llmOverride, send } = {}) {
  // S47（v0.52，K30）：按用途分别解析适配器——分拣与抽取各自记账；抽取带渠道绑定项目 id
  const llm = getLlm(db, llmOverride, { purpose: 'extraction', projectId: channel.projectId ?? null })
  const stats = { events: 0, suggestions: 0, unrouted: 0, unknownSpeakers: 0, botProcessed: 0 }
  const botSeen = db.prepare('SELECT 1 FROM bot_commands WHERE message_id = ?')
  for (const msg of messages) {
    if (msg.id && botSeen.get(msg.id)) {
      stats.botProcessed += 1
      continue
    }
    const speaker = mapSpeaker(db, channel.platform, msg.speakerId, msg.speakerLabel)
    if (!speaker) stats.unknownSpeakers += 1

    let projectId = channel.channelType === 'dedicated' ? channel.projectId : null
    if (channel.channelType === 'general') {
      const routed = await routeMessage(db, { ...msg, speakerLabel: speaker?.name }, { llm })
      const th = getSetting(db, 'thresholds')
      if (!routed.projectId || routed.confidence < th.routingConfidence) {
        db.prepare(
          'INSERT INTO unrouted_messages (platform, group_key, business_time, speaker_label, content, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(channel.platform, channel.groupKey, msg.ts, speaker?.name || msg.speakerLabel || '未识别', msg.text, 'open', Date.now())
        stats.unrouted += 1
        continue
      }
      projectId = routed.projectId
    }
    if (!projectId) continue

    const extracted = await extractEvents(llm, db, projectId, [{ ...msg, speakerMemberId: speaker?.id ?? null, speakerName: speaker?.name || '未识别发言人' }])
    for (const evt of extracted) {
      // S3-3：未识别发言人不得产生针对具体人的任务建议
      if (!speaker && evt.nature === 'suggestion' && evt.targetField === 'responsible_member_id') continue
      const created = addEvent(db, {
        projectId,
        businessTime: msg.ts,
        nature: evt.nature,
        eventType: evt.eventType,
        summary: evt.summary,
        rawSnapshot: msg.text,
        sourcePlatform: channel.platform,
        sourceRef: msg.id,
        speakerMemberId: speaker?.id ?? null,
        speakerLabel: speaker?.name || '未识别发言人',
        confidence: evt.confidence ?? null,
        targetObject: evt.targetObject || 'task',
        targetTaskId: evt.targetTaskId ?? null,
        targetField: evt.targetField ?? null,
        targetValue: evt.targetValue !== undefined ? String(evt.targetValue) : null,
        generatedBy: 'extraction',
      })
      if (created.status === 'pending') {
        stats.suggestions += 1
        await pushSuggestion(db, created, { send })
      } else {
        stats.events += 1
      }
    }
  }
  return stats
}

/** 建议推送（S3-4/S20-2 共用）：目标任务责任人 + 项目牵头人（去重），记 pushed_to。
 *  里程碑目标（S35，target_object='milestone'，id 复用 target_task_id 列）无责任人语义，
 *  且不得按同 id 任务误 JOIN 责任人——只推项目牵头人。
 *  v0.51（S46/K29）：经投递层真实下发（send 注入点；缺省走飞书配置），失败落行不阻塞。 */
export async function pushSuggestion(db, evt, { send } = {}) {
  const target = evt.targetTaskId && evt.targetObject !== 'milestone'
    ? db.prepare('SELECT responsible_member_id AS rid FROM tasks WHERE id = ? AND deleted_at IS NULL').get(evt.targetTaskId)
    : null
  const lead = db.prepare('SELECT lead_member_id AS lid FROM projects WHERE id = ?').get(evt.projectId)
  const recipients = [...new Set([target?.rid, lead?.lid].filter(Boolean))]
  for (const rid of recipients) {
    const m = db.prepare('SELECT * FROM members WHERE id = ?').get(rid)
    if (m) {
      await notifyMember(db, camelizeRow(m), {
        pushType: 'digest',
        title: `待确认建议：${evt.summary}`,
        body: `事件 #${evt.id}（${evt.eventType}）待你确认：同意后生效，驳回则忽略。`,
        projectId: evt.projectId,
      }, { send })
    }
  }
  markPushedTo(db, evt.id, recipients)
}

/** 发言人身份映射：飞书/企微 id → 成员（身份脊柱）。 */
export function mapSpeaker(db, platform, speakerId, _fallbackLabel) {
  if (!speakerId) return null
  const col = platform === 'feishu' ? 'feishu_id' : 'wecom_id'
  const row = db.prepare(`SELECT * FROM members WHERE ${col} = ? AND status = 'active'`).get(speakerId)
  return row ? camelizeRow(row) : null
}

// —— S48（v0.53，K31）未分拣池消化出口：列表 / 归挂（重走抽取）/ 忽略 ——

export function listUnrouted(db, { limit = 100 } = {}) {
  return camelizeRows(
    db.prepare(`SELECT * FROM unrouted_messages WHERE status = 'open' ORDER BY business_time DESC LIMIT ?`).all(limit)
  )
}

export function discardUnrouted(db, id) {
  const row = db.prepare('SELECT * FROM unrouted_messages WHERE id = ?').get(id)
  if (!row) throw Object.assign(new Error('未分拣消息不存在'), { statusCode: 404 })
  if (row.status !== 'open') throw Object.assign(new Error('该消息已处理（已归挂或已忽略）'), { statusCode: 409 })
  db.prepare(`UPDATE unrouted_messages SET status = 'discarded' WHERE id = ?`).run(id)
  return { ok: true }
}

/**
 * 归挂到项目并重走抽取：以原消息时刻/原文/发言人标签产事件（发言人保留原标签、不映射成员——
 * 池内消息没存平台 id，保守不产针对具体人的建议，与 S3-3 同口径）。
 */
export async function routeUnrouted(db, id, projectId, { llm: llmOverride, send } = {}) {
  const row = db.prepare('SELECT * FROM unrouted_messages WHERE id = ?').get(id)
  if (!row) throw Object.assign(new Error('未分拣消息不存在'), { statusCode: 404 })
  if (row.status !== 'open') throw Object.assign(new Error('该消息已处理（已归挂或已忽略）'), { statusCode: 409 })
  const project = db.prepare('SELECT id, name FROM projects WHERE id = ?').get(Number(projectId))
  if (!project) throw Object.assign(new Error('项目不存在'), { statusCode: 404 })
  const llm = getLlm(db, llmOverride, { purpose: 'extraction', projectId: project.id })
  const extracted = await extractEvents(llm, db, project.id, [{ speakerName: row.speaker_label || '未识别发言人', text: row.content }])
  let events = 0
  let suggestions = 0
  for (const evt of extracted) {
    if (evt.nature === 'suggestion' && evt.targetField === 'responsible_member_id') continue // S3-3 同口径
    const created = addEvent(db, {
      projectId: project.id, businessTime: row.business_time, nature: evt.nature, eventType: evt.eventType,
      summary: evt.summary, rawSnapshot: row.content, sourcePlatform: row.platform,
      speakerMemberId: null, speakerLabel: row.speaker_label || '未识别发言人',
      confidence: evt.confidence ?? null, targetObject: evt.targetObject || 'task',
      targetTaskId: evt.targetTaskId ?? null, targetField: evt.targetField ?? null,
      targetValue: evt.targetValue !== undefined ? String(evt.targetValue) : null,
      generatedBy: 'extraction',
    })
    if (created.status === 'pending') { suggestions += 1; await pushSuggestion(db, created, { send }) } else events += 1
  }
  db.prepare(`UPDATE unrouted_messages SET status = 'routed', routed_project_id = ? WHERE id = ?`).run(project.id, id)
  return { ok: true, projectId: project.id, projectName: project.name, events, suggestions }
}

/**
 * LLM 抽取：项目上下文 + 消息 → 事件数组。LLM 未配置时确定性降级：
 * 只产记录型进展事件（绝不自动改任务面，信任边界兜底）。
 */
export async function extractEvents(llm, db, projectId, messages) {
  if (!messages.length) return []
  if (!llm) {
    return messages.map((m) => ({
      nature: 'record',
      eventType: 'progress',
      summary: `${m.speakerName}：${m.text.slice(0, 120)}`,
      confidence: 0.3,
    }))
  }
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId)
  const tasks = db
    .prepare(`SELECT t.id, t.title, t.status, t.plan_end_date, m.name AS owner FROM tasks t LEFT JOIN members m ON m.id = t.responsible_member_id WHERE t.project_id = ? AND t.status IN ('todo','doing') AND t.deleted_at IS NULL`)
    .all(projectId)
  const milestones = db.prepare('SELECT id, name, plan_date FROM milestones WHERE project_id = ? AND status = ?').all(projectId, 'planned')

  const taskList = tasks.map((t) => `#${t.id} ${t.title} [${t.status}${t.plan_end_date ? ` 截止${t.plan_end_date}` : ''}${t.owner ? ` 负责:${t.owner}` : ''}]`).join('\n') || '（无未完任务）'
  const msList = milestones.map((m) => `#${m.id} ${m.name} ${m.plan_date || ''}`).join('\n') || '（无里程碑）'
  const msgList = messages.map((m, i) => `[${i}] ${m.speakerName}: ${m.text}`).join('\n')

  const out = await llm.complete(
    [
      {
        role: 'system',
        content: `你是企业项目大脑的抽取器。从群聊消息中抽取项目事件，输出 JSON {"events":[...]}。
每条事件：{"nature":"record"|"suggestion","eventType":"progress|risk|decision|blocker|finance|schedule_change|status_change|owner_change","summary":"一句中文摘要","confidence":0~1,
"suggestion 时必填":"targetTaskId(上面任务清单里的#id)","targetField":"status|plan_end_date|plan_start_date","targetValue":"对应值(日期用YYYY-MM-DD)"}。
规则：纯进展/风险/决策/财务事实描述 → record（财务类消息如回款/开票/费用沟通 eventType=finance，仅记录、不含金额字段）；明确的任务完成/日期变化信号 → suggestion（如"已上线/完成了" → status=done，"推迟到X" → plan_end_date）；与项目无关的寒暄不要产出；没有把握不要编 targetTaskId。只输出 JSON。`,
      },
      {
        role: 'user',
        content: `项目：${project.name}${project.client_name ? `（客户 ${project.client_name}）` : ''}\n未完任务：\n${taskList}\n里程碑：\n${msList}\n\n消息：\n${msgList}`,
      },
    ],
    { json: true }
  )
  const parsed = parseJsonLoose(out)
  if (!parsed || !Array.isArray(parsed.events)) return []
  const validTasks = new Set(tasks.map((t) => t.id))
  return parsed.events
    .filter((e) => e && e.summary && e.eventType)
    .filter((e) => e.nature !== 'suggestion' || (e.targetTaskId && validTasks.has(Number(e.targetTaskId)) && e.targetField && e.targetValue !== undefined))
    .map((e) => ({
      nature: e.nature === 'suggestion' ? 'suggestion' : 'record',
      eventType: String(e.eventType),
      summary: String(e.summary).slice(0, 200),
      confidence: Number(e.confidence) || null,
      targetTaskId: e.targetTaskId ? Number(e.targetTaskId) : null,
      targetField: e.targetField || null,
      targetValue: e.targetValue,
    }))
}
