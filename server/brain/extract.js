// 大脑·IM 抽取（S3）：专题渠道直接抽取；通用群先 LLM 分拣（低置信进未分拣池）。
// 信任边界：记录型自动生效；建议型（状态/日期/责任人）一律 pending 等人确认。
// S50（v0.55，K33）：噪音确定性预过滤（不进 LLM、不产降级事件）；按项目归组分批抽取
// （≤8 条且 ≤3000 字一批一次调用，事件按 msgIndex 归因源消息，缺省归批次末条）；
// 通用群分拣维持逐条（合并判定会跨消息污染）。

import { camelizeRows, camelizeRow } from '../db/index.mjs'
import { getSetting } from '../engine/settings.js'
import { addEvent, markPushedTo } from '../engine/events.js'
import { addTaskRecord } from '../engine/tasks.js'
import { getLlm, parseJsonLoose } from './llm.js'
import { routeMessage } from './routing.js'
import { notifyMember, notifyAdmins, notifyProjectChannel } from './push.js'
import { buildSuggestionCard } from './bot/cards.js' // S55：建议确认卡
import { label } from '../engine/enums.js'
import { acceptanceAlarm } from '../engine/metrics.js'
import * as feishu from './connectors/feishu.js'
import * as wecom from './connectors/wecom.js'

const CONNECTORS = { feishu, wecom }

/** 定时/按需触发入口（action 端点 / 调度器）：按渠道配置拉增量并抽取。 */
export async function runExtraction(db, { channelId, projectId } = {}, { llm, send, connectors } = {}) {
  const CONN = connectors || CONNECTORS // S60：测试可注入 mock 连接器（生产走默认）
  const channels = camelizeRows(
    channelId
      ? db.prepare('SELECT * FROM channels WHERE id = ?').all(channelId)
      : db.prepare('SELECT * FROM channels').all()
  ).filter((c) => !projectId || c.channelType === 'general' || c.projectId === projectId)

  const results = []
  const progressByProject = new Map() // S60：本轮沉淀的 record 型 progress 事件（projectId → [{summary, projectName}]）
  for (const ch of channels) {
    const row = { channelId: ch.id, platform: ch.platform }
    // S52：① 先排干事件流缓冲（独立于 API 拉取；失败不标记、下轮重试）
    try {
      const drained = await drainBuffer(db, ch, { llm, send })
      if (drained) Object.assign(row, drained)
    } catch (e) {
      row.bufferError = e.message
    }
    // ② API 游标对账（既有语义：失败不推进游标）
    try {
      const cfg = getSetting(db, `im.${ch.platform}`)
      const { messages, nextCursor } = await CONN[ch.platform].fetchMessages(cfg, ch, ch.cursor)
      const ingested = await ingestMessages(db, ch, messages, { llm, send })
      db.prepare('UPDATE channels SET cursor = ?, last_pull_at = ? WHERE id = ?').run(nextCursor, Date.now(), ch.id)
      Object.assign(row, { pulled: messages.length, events: (row.events ?? 0) + (ingested.events ?? 0), suggestions: (row.suggestions ?? 0) + (ingested.suggestions ?? 0), unrouted: (row.unrouted ?? 0) + (ingested.unrouted ?? 0), noiseSkipped: (row.noiseSkipped ?? 0) + (ingested.noiseSkipped ?? 0), bufferSkipped: (row.bufferSkipped ?? 0) + (ingested.bufferSkipped ?? 0) })
      // S60：收集本轮进展（排干缓冲与 API 两路都汇聚）
      for (const ev of ingested.progressEvents ?? []) {
        if (!progressByProject.has(ev.projectId)) progressByProject.set(ev.projectId, [])
        progressByProject.get(ev.projectId).push(ev)
      }
    } catch (e) {
      row.error = e.message
    }
    results.push(row)
  }
  // S60：抽取后群进展播报（周期尾部，三道闸任一不过即静默）
  await broadcastProgress(db, progressByProject, { send })
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
 * S60（v0.65，K44）群进展播报：把本轮各项目沉淀的 record 型 progress 事件按项目聚合，
 * 往项目绑定的飞书专题群（dedicated）发绿色「🎉 有新进展」汇总卡。
 * 三道闸（任一不过即静默）：本轮没拉到新群消息 / 拉到的全是噪音闲聊 / 抽取出事件但无一条
 * record 型 progress——progressByProject 为空即整体静默，单项目无进展即跳过该项目。
 * 幂等：同调度周期（小时级 cron）同项目已播报过则不重复发（pushes 台账锚点）。
 */
async function broadcastProgress(db, progressByProject, { send } = {}) {
  if (!progressByProject.size) return // 闸：本轮零进展
  const cycleStart = Date.now() - 3600_000 // extraction 默认每小时一轮：同周期 = 近一小时内已播报过
  const { buildProgressDigestCard, progressDigestBody } = await import('./bot/cards.js')
  for (const [projectId, items] of progressByProject) {
    if (!items.length) continue // 闸：该项目本轮无进展
    const dup = db.prepare(
      `SELECT 1 FROM pushes WHERE push_type = 'progress_digest' AND related_project_id = ? AND created_at >= ?`
    ).get(projectId, cycleStart)
    if (dup) continue // 幂等：同周期已播报
    const projectName = items[0].projectName
    await notifyProjectChannel(db, projectId, {
      pushType: 'progress_digest',
      title: `🎉 ${projectName} 有新进展`,
      body: progressDigestBody({ items }),
      card: buildProgressDigestCard({ projectName, items }),
    }, { send })
  }
}

/**
 * S50 噪音预过滤（确定性，先于分拣/抽取/降级）：只滤「绝不可能是项目信息」的——
 * 空文本、纯表情/标点/符号、精确命中的应酬白名单、单字符。含实义的短消息（「完成了」）必须放行。
 */
const NOISE_ACKS = new Set(['收到', '好的', '好', 'ok', 'okay', '👌', '👍', '谢谢', '感谢', '嗯', '嗯嗯', '了解', '明白', '+1', '666', '哈哈', '哈哈哈', '辛苦了', '可以', '行', '对', '是的'])
export function isNoiseMessage(text) {
  const t = String(text || '').trim()
  if (!t) return true
  if (t.length <= 1) return true
  if (NOISE_ACKS.has(t.toLowerCase()) || NOISE_ACKS.has(t)) return true
  return /^[\p{Emoji}\p{P}\p{S}\s]+$/u.test(t) // 纯表情/标点/符号
}

// S50 批量护栏：每批 ≤8 条且消息累计 ≤3000 字（成本与上下文预算，代码常量）
const BATCH_MAX_MESSAGES = 8
const BATCH_MAX_CHARS = 3000

/** 把同项目消息切成批次（保序）。 */
function chunkBatches(items) {
  const batches = []
  let cur = []
  let chars = 0
  for (const item of items) {
    const len = String(item.msg.text || '').length
    if (cur.length && (cur.length >= BATCH_MAX_MESSAGES || chars + len > BATCH_MAX_CHARS)) {
      batches.push(cur)
      cur = []
      chars = 0
    }
    cur.push(item)
    chars += len
  }
  if (cur.length) batches.push(cur)
  return batches
}

/**
 * 消息批量入库（测试直调；连接器喂数据的统一通道）。
 * 流程：机器人去重 → 噪音预过滤 → 身份映射 →（通用群）逐条分拣 → 按项目归组分批抽取 → 事件写入。
 * S20-10：机器人已处理/已回复的消息（bot_commands 有 message_id）跳过，防同一消息双入库。
 */
export async function ingestMessages(db, channel, messages, { llm: llmOverride, send } = {}) {
  const stats = { events: 0, suggestions: 0, unrouted: 0, unknownSpeakers: 0, botProcessed: 0, noiseSkipped: 0, bufferSkipped: 0, taskRecords: 0, progressEvents: [] } // S60：progressEvents 供周期尾部播报聚合
  const projectNameCache = new Map() // S60：projectId → 项目名（播报卡片标题用，单次 ingest 内查一次）
  // S20-10 去重口径（v0.57 修订）：机器人「指令已处理/已回复」的消息跳过；refused_not_mentioned 的
  // 未@忽略行不算已处理——正是 S52 缓冲要抽取的内容，不排除（否则缓冲排干会被全部误跳）。
  const botSeen = db.prepare(
    `SELECT 1 FROM bot_commands WHERE message_id = ? AND (kind = 'bot_reply' OR (kind = 'command' AND result != 'refused_not_mentioned'))`
  )
  // S52：API 对账重拉到缓冲已消费的消息 → 跳过（零 LLM 零重复事件）
  const bufferSeen = db.prepare('SELECT 1 FROM im_buffer WHERE message_id = ? AND consumed_at IS NOT NULL')

  // ① 去重 + 噪音预过滤 + 身份映射
  const prepared = []
  for (const msg of messages) {
    if (msg.id && botSeen.get(msg.id)) {
      stats.botProcessed += 1
      continue
    }
    if (msg.id && bufferSeen.get(msg.id)) {
      stats.bufferSkipped += 1
      continue
    }
    if (isNoiseMessage(msg.text)) {
      stats.noiseSkipped += 1
      continue
    }
    const speaker = mapSpeaker(db, channel.platform, msg.speakerId, msg.speakerLabel)
    if (!speaker) stats.unknownSpeakers += 1
    prepared.push({ msg: { ...msg, speakerMemberId: speaker?.id ?? null, speakerName: speaker?.name || '未识别发言人' }, speaker })
  }

  // ② 通用群逐条分拣（不合并：跨消息判定会互相污染，K33）；专题渠道直接落定
  const settled = [] // { msg, speaker, projectId }
  for (const item of prepared) {
    let projectId = channel.channelType === 'dedicated' ? channel.projectId : null
    if (channel.channelType === 'general') {
      const routed = await routeMessage(db, { ...item.msg, speakerLabel: item.speaker?.name }, { llm: llmOverride })
      const th = getSetting(db, 'thresholds')
      if (!routed.projectId || routed.confidence < th.routingConfidence) {
        db.prepare(
          'INSERT INTO unrouted_messages (platform, group_key, business_time, speaker_label, content, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(channel.platform, channel.groupKey, item.msg.ts, item.speaker?.name || item.msg.speakerLabel || '未识别', item.msg.text, 'open', Date.now())
        stats.unrouted += 1
        continue
      }
      projectId = routed.projectId
    }
    if (projectId) settled.push({ ...item, projectId })
  }

  // ③ 按项目归组、分批抽取（S47：按用途记账，项目 id 随行）
  const byProject = new Map()
  for (const item of settled) {
    const list = byProject.get(item.projectId) || []
    list.push(item)
    byProject.set(item.projectId, list)
  }
  for (const [projectId, items] of byProject) {
    const llm = getLlm(db, llmOverride, { purpose: 'extraction', projectId })
    for (const batch of chunkBatches(items)) {
      const extracted = await extractEvents(llm, db, projectId, batch.map((i) => i.msg))
      for (const evt of extracted) {
        const source = evt.sourceMsg || batch[batch.length - 1].msg
        // S3-3：未识别发言人不得产生针对具体人的任务建议（按事件的源消息发言人判定，S50 批量延伸）
        if (evt.nature === 'suggestion' && evt.targetField === 'responsible_member_id' && !source.speakerMemberId) continue
        const created = addEvent(db, {
          projectId,
          businessTime: source.ts,
          nature: evt.nature,
          eventType: evt.eventType,
          summary: evt.summary,
          rawSnapshot: source.text,
          sourcePlatform: channel.platform,
          sourceRef: source.id,
          speakerMemberId: source.speakerMemberId,
          speakerLabel: source.speakerName,
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
          // S60：record 型 progress 事件收集供周期尾部播报（不落台账、不阻塞，仅聚合摘要）
          if (evt.eventType === 'progress') {
            if (!projectNameCache.has(projectId)) {
              projectNameCache.set(projectId, db.prepare('SELECT name FROM projects WHERE id = ?').get(projectId)?.name || `项目#${projectId}`)
            }
            stats.progressEvents.push({ projectId, projectName: projectNameCache.get(projectId), summary: evt.summary })
          }
          // S56（v0.61，K39）：记录型事件带合法任务归属 → 同步归档任务时间线
          // （复用 addTaskRecord 既有守卫：终态项目/已删任务静默跳过，不阻塞事件与后续消息）
          if (evt.targetTaskId) {
            try {
              addTaskRecord(db, { taskId: evt.targetTaskId, content: evt.summary }, source.speakerMemberId)
              stats.taskRecords += 1
            } catch { /* 终态只读/任务已删 → 静默跳过 */ }
          }
        }
      }
    }
  }
  return stats
}

/** 建议推送（S3-4/S20-2 共用）：目标任务责任人 + 项目牵头人（去重），记 pushed_to。
 *  里程碑目标（S35，target_object='milestone'，id 复用 target_task_id 列）无责任人语义，
 *  且不得按同 id 任务误 JOIN 责任人——只推项目牵头人。
 *  v0.51（S46/K29）：经投递层真实下发（send 注入点；缺省走飞书配置），失败落行不阻塞。
 *  v0.60（S55/K38）：飞书绑定成员 + 有签名密钥时改发确认卡（确认/驳回按钮，HMAC 与 S20 卡同构，
 *  点按由 handleCardAction 的 confirm/reject 分支承接）；缺密钥/未绑定/发卡失败降级文本推送。 */
export async function pushSuggestion(db, evt, { send, secret } = {}) {
  const target = evt.targetTaskId && evt.targetObject !== 'milestone'
    ? db.prepare('SELECT responsible_member_id AS rid FROM tasks WHERE id = ? AND deleted_at IS NULL').get(evt.targetTaskId)
    : null
  const lead = db.prepare('SELECT lead_member_id AS lid FROM projects WHERE id = ?').get(evt.projectId)
  const recipients = [...new Set([target?.rid, lead?.lid].filter(Boolean))]
  const hmacSecret = secret ?? process.env.GB_PMO_SESSION_SECRET ?? ''
  const project = db.prepare('SELECT name FROM projects WHERE id = ?').get(evt.projectId)
  for (const rid of recipients) {
    const m = db.prepare('SELECT * FROM members WHERE id = ?').get(rid)
    if (m) {
      const member = camelizeRow(m)
      // S55：卡片仅在「绑定飞书 + 有签名密钥」时有意义（按钮回调要能过签名校验）
      const card = member.feishuId && hmacSecret
        ? buildSuggestionCard({ id: evt.id, summary: evt.summary, projectName: project?.name, typeLabel: label('eventType', evt.eventType) }, hmacSecret)
        : null
      await notifyMember(db, member, {
        pushType: 'digest',
        title: `待确认建议：${evt.summary}`,
        body: `事件 #${evt.id}（${evt.eventType}）待你确认：同意后生效，驳回则忽略。`,
        projectId: evt.projectId,
        card,
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

// —— S52（v0.57，K35）事件驱动抽取缓冲 ——

/** 网关落缓冲：仅已绑定渠道（专题/通用）的群消息；message_id 全局去重（INSERT OR IGNORE）。 */
export function bufferInboundMessage(db, { platform = 'feishu', groupKey, messageId, speakerId, text, ts }) {
  if (!messageId || !text || !groupKey) return false
  const bound = db.prepare('SELECT 1 FROM channels WHERE platform = ? AND group_key = ?').get(platform, groupKey)
  if (!bound) return false
  db.prepare(
    'INSERT OR IGNORE INTO im_buffer (platform, group_key, message_id, speaker_id, text, ts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(platform, groupKey, messageId, speakerId || null, String(text).slice(0, 2000), ts || Date.now(), Date.now())
  return true
}

/** 滚动清理：已消费行保留 7 天供双源去重，超期删除。 */
export function pruneBuffer(db, { now = Date.now(), keepMs = 7 * 86400000 } = {}) {
  return db.prepare('DELETE FROM im_buffer WHERE consumed_at IS NOT NULL AND consumed_at < ?').run(now - keepMs).changes
}

/**
 * 排干一个渠道的缓冲：按消息时刻升序喂既有入库管线（噪音过滤/分拣/批量全继承），
 * 成功后整批标记 consumed_at（失败不标记、下轮重试——与渠道游标「失败不推进」同哲学）。
 */
export async function drainBuffer(db, channel, opts = {}) {
  const rows = db
    .prepare('SELECT * FROM im_buffer WHERE platform = ? AND group_key = ? AND consumed_at IS NULL ORDER BY ts, id')
    .all(channel.platform, channel.groupKey)
  if (!rows.length) return null
  const stats = await ingestMessages(db, channel, rows.map((r) => ({
    id: r.message_id, speakerId: r.speaker_id, speakerLabel: r.speaker_label, text: r.text, ts: r.ts,
  })), opts)
  db.prepare(`UPDATE im_buffer SET consumed_at = ? WHERE id IN (${rows.map(() => '?').join(',')})`)
    .run(Date.now(), ...rows.map((r) => r.id))
  pruneBuffer(db)
  return { buffered: rows.length, ...stats }
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
    if (created.status === 'pending') { suggestions += 1; await pushSuggestion(db, created, { send }) } else {
      events += 1
      // S56：记录型事件带任务归属 → 同步归档任务时间线（终态/已删静默跳过）
      if (evt.targetTaskId) {
        try { addTaskRecord(db, { taskId: evt.targetTaskId, content: evt.summary }, null) } catch { /* 静默跳过 */ }
      }
    }
  }
  db.prepare(`UPDATE unrouted_messages SET status = 'routed', routed_project_id = ? WHERE id = ?`).run(project.id, id)
  return { ok: true, projectId: project.id, projectName: project.name, events, suggestions }
}

/**
 * LLM 抽取：项目上下文 + 消息（可多条，S50 批量） → 事件数组（每条附 sourceMsg 源消息）。
 * 多条时 prompt 追加 msgIndex 归因约定；LLM 缺省/越界时归批次末条（LLM 答复通常针对最新消息）。
 * LLM 未配置时确定性降级：只产记录型进展事件（绝不自动改任务面，信任边界兜底）。
 */
export async function extractEvents(llm, db, projectId, messages) {
  if (!messages.length) return []
  if (!llm) {
    return messages.map((m) => ({
      nature: 'record',
      eventType: 'progress',
      summary: `${m.speakerName}：${m.text.slice(0, 120)}`,
      confidence: 0.3,
      sourceMsg: m,
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
  const multi = messages.length > 1 // S50：多条时启用 msgIndex 归因约定

  const out = await llm.complete(
    [
      {
        role: 'system',
        content: `你是企业项目大脑的抽取器。从群聊消息中抽取项目事件，输出 JSON {"events":[...]}。
每条事件：{"nature":"record"|"suggestion","eventType":"progress|risk|decision|blocker|finance|schedule_change|status_change|owner_change","summary":"一句中文摘要","confidence":0~1,
"suggestion 时必填":"targetTaskId(上面任务清单里的#id)","targetField":"status|plan_end_date|plan_start_date","targetValue":"对应值(日期用YYYY-MM-DD)"}。
规则：纯进展/风险/决策/财务事实描述 → record（财务类消息如回款/开票/费用沟通 eventType=finance，仅记录、不含金额字段）；消息明确在说某条任务的进展/情况时 record 事件也可带 targetTaskId（摘要会同步归档到该任务的更新记录，S56）；明确的任务完成/日期变化信号 → suggestion（如"已上线/完成了" → status=done，"推迟到X" → plan_end_date）；与项目无关的寒暄不要产出；没有把握不要编 targetTaskId。${multi ? '每条事件附 "msgIndex"（消息编号 [i] 的 i，0 基）指明来源消息；无法确定时省略。' : ''}只输出 JSON。`,
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
    .map((e) => {
      const idx = Number.isInteger(e.msgIndex) && e.msgIndex >= 0 && e.msgIndex < messages.length ? e.msgIndex : messages.length - 1
      // S56：记录型的 targetTaskId 也须属本项目未删任务——非法 id 丢弃字段不丢事件
      const tid = e.targetTaskId && validTasks.has(Number(e.targetTaskId)) ? Number(e.targetTaskId) : null
      return {
        nature: e.nature === 'suggestion' ? 'suggestion' : 'record',
        eventType: String(e.eventType),
        summary: String(e.summary).slice(0, 200),
        confidence: Number(e.confidence) || null,
        targetTaskId: tid,
        targetField: e.targetField || null,
        targetValue: e.targetValue,
        sourceMsg: messages[idx], // S50：事件归因源消息（缺省/越界归批次末条）
      }
    })
}
