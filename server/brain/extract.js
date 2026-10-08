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
export async function runExtraction(db, { channelId, projectId } = {}, { llm } = {}) {
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
      const ingested = await ingestMessages(db, ch, messages, { llm })
      db.prepare('UPDATE channels SET cursor = ?, last_pull_at = ? WHERE id = ?').run(nextCursor, Date.now(), ch.id)
      results.push({ channelId: ch.id, platform: ch.platform, pulled: messages.length, ...ingested })
    } catch (e) {
      results.push({ channelId: ch.id, platform: ch.platform, error: e.message })
    }
  }
  // S3-5：采纳率告警（周窗口低于阈值 → 告警管理员）
  const alarm = acceptanceAlarm(db)
  if (alarm) {
    notifyAdmins(db, {
      pushType: 'alert',
      title: `大脑抽取采纳率低于阈值（${Math.round(alarm.rate * 100)}% < ${Math.round(alarm.threshold * 100)}%）`,
      body: `近 7 天生成建议 ${alarm.generated} 条，被采纳 ${alarm.accepted} 条。请在配置台调整抽取策略或阈值。`,
    })
    results.push({ acceptanceAlarm: alarm })
  }
  return { channels: results }
}

/**
 * 消息批量入库（测试直调；连接器喂数据的统一通道）。
 * 每条消息：身份映射 → （通用群）分拣 → LLM 抽取 → 事件写入。
 * S20-10：机器人已处理/已回复的消息（bot_commands 有 message_id）跳过，防同一消息双入库。
 */
export async function ingestMessages(db, channel, messages, { llm: llmOverride } = {}) {
  const llm = getLlm(db, llmOverride)
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
        pushSuggestion(db, created)
      } else {
        stats.events += 1
      }
    }
  }
  return stats
}

/** 建议推送（S3-4/S20-2 共用）：目标任务责任人 + 项目牵头人（去重），记 pushed_to。
 *  里程碑目标（S35，target_object='milestone'，id 复用 target_task_id 列）无责任人语义，
 *  且不得按同 id 任务误 JOIN 责任人——只推项目牵头人。 */
export function pushSuggestion(db, evt) {
  const target = evt.targetTaskId && evt.targetObject !== 'milestone'
    ? db.prepare('SELECT responsible_member_id AS rid FROM tasks WHERE id = ?').get(evt.targetTaskId)
    : null
  const lead = db.prepare('SELECT lead_member_id AS lid FROM projects WHERE id = ?').get(evt.projectId)
  const recipients = [...new Set([target?.rid, lead?.lid].filter(Boolean))]
  for (const rid of recipients) {
    const m = db.prepare('SELECT * FROM members WHERE id = ?').get(rid)
    if (m) {
      notifyMember(db, camelizeRow(m), {
        pushType: 'digest',
        title: `待确认建议：${evt.summary}`,
        body: `事件 #${evt.id}（${evt.eventType}）待你确认：同意后生效，驳回则忽略。`,
        projectId: evt.projectId,
      })
    }
  }
  markPushedTo(db, evt.id, recipients)
}

/** 发言人身份映射：飞书/企微 id → 成员（身份脊柱）。 */
export function mapSpeaker(db, platform, speakerId, fallbackLabel) {
  if (!speakerId) return null
  const col = platform === 'feishu' ? 'feishu_id' : 'wecom_id'
  const row = db.prepare(`SELECT * FROM members WHERE ${col} = ? AND status = 'active'`).get(speakerId)
  return row ? camelizeRow(row) : null
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
    .prepare(`SELECT t.id, t.title, t.status, t.plan_end_date, m.name AS owner FROM tasks t LEFT JOIN members m ON m.id = t.responsible_member_id WHERE t.project_id = ? AND t.status IN ('todo','doing')`)
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
每条事件：{"nature":"record"|"suggestion","eventType":"progress|risk|decision|blocker|schedule_change|status_change|owner_change","summary":"一句中文摘要","confidence":0~1,
"suggestion 时必填":"targetTaskId(上面任务清单里的#id)","targetField":"status|plan_end_date|plan_start_date","targetValue":"对应值(日期用YYYY-MM-DD)"}。
规则：纯进展/风险/决策描述 → record；明确的任务完成/日期变化信号 → suggestion（如"已上线/完成了" → status=done，"推迟到X" → plan_end_date）；与项目无关的寒暄不要产出；没有把握不要编 targetTaskId。只输出 JSON。`,
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
