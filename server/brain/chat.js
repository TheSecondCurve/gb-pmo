// S24（v0.16）Web AI 助手会话编排：与 S20 飞书机器人同一核心 Agent（runAgentLoop + bot/tools），
// 差异只在编排层——web 身份=登录会话成员（无需绑定码）、无渠道上下文、建议型在页面确认。
// 会话/消息持久化（chat_sessions/chat_messages，软删）；限额与审计复用 bot_commands（platform='web'）。

import { getSetting } from '../engine/settings.js'
import { getLlm } from './llm.js'
import { runAgentLoop, MAX_HISTORY } from './bot/agent.js'
import { runQueryTool, runMetricTool, runWriteTool } from './bot/tools.js'
import { buildSystemPrompt } from './bot/command.js'
import { bjDayStartMs } from '../db/time.js'

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

// —— 发消息：限额 → 审计 → 核心循环 → 落库 ——

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

  // 每日限额（北京日；含本条）
  const quota = getSetting(db, 'chat').quotaPerDay
  const used = db
    .prepare(`SELECT COUNT(*) AS n FROM bot_commands WHERE member_id = ? AND kind = 'command' AND platform = 'web' AND created_at >= ?`)
    .get(memberId, bjDayStartMs()).n
  if (used > quota) {
    const assistant = insertMessage(db, session.id, 'assistant', `今天的指令额度（${quota} 条）已用完，明天再来找我吧。`, { result: 'refused_quota' })
    finish({ intent: 'gate', result: 'refused_quota' })
    return { user: userMsg, assistant, session: getSession(db, memberId, session.id) }
  }

  // LLM 未配置：明确指引，不抛错
  const llm = getLlm(db, opts.llm)
  if (!llm) {
    const assistant = insertMessage(
      db, session.id, 'assistant',
      '系统未配置 LLM，AI 助手暂不可用。管理员可在配置台「外部依赖 → LLM」配置任一类别（DeepSeek / GLM 国内 Coding Plan）后再来。',
      { result: 'no_llm' }
    )
    finish({ intent: 'gate', result: 'no_llm' })
    return { user: userMsg, assistant, session: getSession(db, memberId, session.id) }
  }

  // 核心循环（读自由写收敛，与 S20 同源）
  const member = db.prepare('SELECT id, name, role, status FROM members WHERE id = ?').get(memberId)
  const sqlLog = []
  const execTool = async (parsed) => {
    if (parsed.action === 'query') {
      try {
        const r = runQueryTool(db, parsed.sql)
        sqlLog.push(String(parsed.sql).slice(0, 500))
        return `${JSON.stringify(r.rows).slice(0, 4000)}（${r.count} 行${r.truncated ? '，已截断' : ''}）`
      } catch (e) {
        return `查询失败：${e.message}（修正 SQL 重试，或基于已有信息 reply）`
      }
    }
    if (parsed.action === 'metric') {
      try {
        return JSON.stringify(runMetricTool(db, parsed.id, parsed.params)).slice(0, 4000)
      } catch (e) {
        return `指标失败：${e.message}`
      }
    }
    if (parsed.action === 'write') {
      return runWriteTool(db, { kind: parsed.kind, payload: parsed.payload }, { member, llm, sourcePlatform: 'web' })
    }
    return '未知动作'
  }
  const history = listMessages(db, memberId, session.id)
    .messages.filter((m) => m.id !== userMsg.id)
    .slice(-MAX_HISTORY)
    .map((m) => ({ role: m.role, content: m.content }))
  const out = await runAgentLoop({
    llm,
    systemPrompt: buildSystemPrompt(db, { member, channel: null, chatType: 'p2p', surface: 'web' }),
    userText: content,
    history,
    execTool,
  })

  const detail = { llmCalls: out.turns, queries: out.queries, sql: sqlLog }
  let assistant
  if (out.kind === 'reply') {
    assistant = insertMessage(db, session.id, 'assistant', out.text || '（空回复）', { result: out.result, ...detail })
    finish({ intent: 'reply', result: out.result, ...detail })
  } else {
    const w = out.writeResult ?? {}
    if (w.type === 'card' && w.cardKind === 'suggest') {
      // web 无卡片：直接给事件号 + 生效/驳回指引（页面按钮走既有 confirm/reject 口子）
      const text = `已生成建议事件 #${w.eventId}（${w.summary}），待确认后才会变更任务——在下方点「生效」或「驳回」，确认人留痕。`
      assistant = insertMessage(db, session.id, 'assistant', text, { result: 'card_sent', eventId: w.eventId, writeKind: w.cardKind, ...detail })
      finish({ intent: `write:${w.cardKind}`, result: 'card_sent', ...detail })
    } else {
      assistant = insertMessage(db, session.id, 'assistant', w.text || '操作完成。', { result: w.result || 'replied', writeKind: w.type, ...detail })
      finish({ intent: `write:${w.type ?? '?'}`, result: w.result || 'replied', ...detail })
    }
  }
  return { user: userMsg, assistant, session: getSession(db, memberId, session.id) }
}
