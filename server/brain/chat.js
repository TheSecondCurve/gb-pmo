// S24（v0.16）Web AI 助手会话编排：与 S20 飞书机器人同一核心 Agent（统一会话管线 pipeline.js，K12），
// 差异只在适配层——web 身份=登录会话成员（无需绑定码）、无渠道上下文、建议型在页面确认（无卡片）。
// 会话/消息持久化（chat_sessions/chat_messages，软删）；限额与审计复用 bot_commands（platform='web'）。

import { MAX_HISTORY } from './bot/agent.js'
import { runConversation } from './bot/pipeline.js'
import { buildSystemPrompt } from './bot/command.js'

const notFound = (msg = '会话不存在') => Object.assign(new Error(msg), { statusCode: 404 })

// —— 会话管理（本人专属，软删） ——

export function listSessions(db, memberId) {
  const rows = db
    .prepare('SELECT id, title, created_at, updated_at FROM chat_sessions WHERE member_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC, id DESC')
    .all(memberId)
  return { sessions: rows }
}

export function createSession(db, memberId, { title } = {}) {
  const now = Date.now()
  const ins = db
    .prepare('INSERT INTO chat_sessions (member_id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(memberId, String(title || '新会话').slice(0, 60), now, now)
  return getSession(db, memberId, Number(ins.lastInsertRowid))
}

export function renameSession(db, memberId, id, title) {
  const s = requireOwned(db, memberId, id)
  const t = String(title || '').trim().slice(0, 60)
  if (!t) throw Object.assign(new Error('title 不能为空'), { statusCode: 400 })
  db.prepare('UPDATE chat_sessions SET title = ?, updated_at = ? WHERE id = ?').run(t, Date.now(), s.id)
  return getSession(db, memberId, s.id)
}

export function deleteSession(db, memberId, id) {
  const s = requireOwned(db, memberId, id)
  db.prepare('UPDATE chat_sessions SET deleted_at = ?, updated_at = ? WHERE id = ?').run(Date.now(), Date.now(), s.id)
  return { ok: true }
}

export function getSession(db, memberId, id) {
  const s = db
    .prepare('SELECT id, member_id, title, created_at, updated_at FROM chat_sessions WHERE id = ? AND deleted_at IS NULL')
    .get(Number(id))
  if (!s) throw notFound()
  if (s.member_id !== memberId) throw notFound() // 归属隔离：他人一律 404（不泄露存在性）
  return s
}

function requireOwned(db, memberId, id) {
  return getSession(db, memberId, id)
}

export function listMessages(db, memberId, sessionId) {
  getSession(db, memberId, sessionId) // 归属校验（404）
  const rows = db
    .prepare('SELECT id, role, content, meta, created_at FROM chat_messages WHERE session_id = ? ORDER BY id')
    .all(Number(sessionId))
  return { messages: rows.map((r) => ({ ...r, meta: r.meta ? JSON.parse(r.meta) : null })) }
}

function insertMessage(db, sessionId, role, content, meta) {
  const now = Date.now()
  const ins = db
    .prepare('INSERT INTO chat_messages (session_id, role, content, meta, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(Number(sessionId), role, String(content || ''), meta ? JSON.stringify(meta) : null, now)
  db.prepare('UPDATE chat_sessions SET updated_at = ? WHERE id = ?').run(now, Number(sessionId))
  const row = db.prepare('SELECT id, role, content, meta, created_at FROM chat_messages WHERE id = ?').get(Number(ins.lastInsertRowid))
  return { ...row, meta: row.meta ? JSON.parse(row.meta) : null }
}

// —— 发消息：审计 → 统一管线（斜杠/限额/降级/循环）→ 落库 ——

/** web 会话历史（S24-2 + v0.25 /new 水位线）：水位线之后、排除斜杠命令与其回执（与 S20-13 负面清单同构）。 */
function assembleWebHistory(db, memberId, sessionId, excludeMessageId) {
  const watermark = db.prepare('SELECT MAX(cleared_at) AS t FROM bot_context_resets WHERE platform = ? AND chat_id = ?')
    .get('web', String(sessionId))?.t ?? 0
  const slashIntent = new Set(['help', 'context', 'bind'])
  return listMessages(db, memberId, sessionId).messages
    .filter((m) => m.id !== excludeMessageId)
    .filter((m) => m.created_at > watermark)
    .filter((m) => !(m.role === 'user' && String(m.content).startsWith('/')))
    .filter((m) => !(m.role === 'assistant' && slashIntent.has(m.meta?.intent)))
    .slice(-MAX_HISTORY)
    .map((m) => ({ role: m.role, content: m.content }))
}

/**
 * @param {object} opts { llm(测试注入 fake) }
 * @returns { user, assistant, session }（assistant.meta 含 result/llmCalls/queries，建议型带 eventId）
 */
export async function sendChatMessage(db, { memberId, sessionId, text }, opts = {}) {
  const session = requireOwned(db, memberId, sessionId)
  const content = String(text || '').trim()
  if (!content) throw Object.assign(new Error('text 不能为空'), { statusCode: 400 })
  if (content.length > 2000) throw Object.assign(new Error('text 过长（≤2000 字）'), { statusCode: 400 })

  const startedAt = Date.now()
  const userMsg = insertMessage(db, session.id, 'user', content, null)
  // 审计行：message_id 绑定用户消息行 id，天然唯一幂等
  const auditId = `web:${userMsg.id}`
  db.prepare(
    `INSERT OR IGNORE INTO bot_commands (message_id, platform, chat_id, chat_type, member_id, kind, raw_text, created_at)
     VALUES (?, 'web', ?, 'p2p', ?, 'command', ?, ?)`
  ).run(auditId, String(session.id), memberId, content.slice(0, 2000), startedAt)
  const finish = (meta) => {
    db.prepare('UPDATE bot_commands SET intent = ?, detail = ?, result = ?, llm_calls = ?, duration_ms = ? WHERE message_id = ?')
      .run(meta.intent ?? null, JSON.stringify({ turns: meta.llmCalls ?? 0, queries: meta.queries ?? 0, sql: meta.sql ?? [] }),
        meta.result, meta.llmCalls ?? null, Date.now() - startedAt, auditId)
  }

  // 标题自动化：未改名（仍为默认）的会话取首条用户消息前 20 字
  if (session.title === '新会话') {
    db.prepare('UPDATE chat_sessions SET title = ? WHERE id = ? AND title = ?').run(content.slice(0, 20), session.id, '新会话')
  }

  const member = db.prepare('SELECT id, name, role, status FROM members WHERE id = ?').get(memberId)

  // 文本出口统一经 reply：落 assistant 消息（meta 带结果/意图/用量）+ 审计收尾（斜杠/限额/降级/答复共用）
  let lastAssistant = null
  const reply = async (replyText, patch = {}) => {
    const meta = { result: patch.result, ...(patch.intent ? { intent: patch.intent } : {}) }
    if (patch.detail) {
      meta.llmCalls = patch.llmCalls
      meta.queries = patch.detail.queries
      meta.sql = patch.detail.sql
    }
    if (patch.writeKind) meta.writeKind = patch.writeKind
    lastAssistant = insertMessage(db, session.id, 'assistant', replyText, meta)
    finish({ intent: patch.intent, result: patch.result, llmCalls: patch.llmCalls, queries: patch.detail?.queries, sql: patch.detail?.sql })
    return { result: patch.result }
  }

  const out = await runConversation(db, {
    surface: 'web', platform: 'web', chatId: String(session.id), chatType: 'p2p', member,
    text: content, ts: Date.now(), messageId: auditId,
  }, {
    llm: opts.llm,
    history: assembleWebHistory(db, memberId, session.id, userMsg.id),
    reply,
    systemPrompt: buildSystemPrompt(db, { member, channel: null, chatType: 'p2p', surface: 'web' }),
  })

  // 卡片出口：web 无卡片——提议（v0.46 起仅取消/结项）给编号 + 页面「生效/驳回」按钮（S24-3/S25，走既有确认口子）
  if (out?.type === 'card') {
    const w = out.writeResult
    const cardText = `已生成提议 #${w.proposalId}（${w.summary}），待有权人确认后才会生效——在下方点「生效」或「驳回」。`
    lastAssistant = insertMessage(db, session.id, 'assistant', cardText, {
      result: 'card_sent', intent: `write:${w.cardKind}`, writeKind: w.cardKind,
      proposalId: w.proposalId,
      llmCalls: out.llmCalls, queries: out.detail.queries, sql: out.detail.sql,
    })
    finish({ intent: `write:${w.cardKind}:${w.kind}`, result: 'card_sent', llmCalls: out.llmCalls, queries: out.detail.queries, sql: out.detail.sql })
  }
  return { user: userMsg, assistant: lastAssistant, session: getSession(db, memberId, session.id) }
}
