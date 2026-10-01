// S20-13/14/15（v0.23）机器人会话历史装配：会话域 (platform, chat_id) + 空闲窗 + /new 水位线 + 条数/字数双上限。
// 只注入真实问答（LLM 问答对 / 写回执 / 卡片回执与点按结果）；斜杠命令（凭据纪律）、门禁引导、
// 未绑定消息（member_id 空）、web 会话（platform=web）一律不进。装配失败由调用方降级为无历史。

export const HISTORY_CHAR_BUDGET = 6000 // 历史块总字数上限（成本护栏，代码常量非配置项）
const ENTRY_MAX_CHARS = 600             // 单条截断（旧回合细节价值低）
const FETCH_LIMIT = 60                  // 放宽取回，JS 里按双上限从新往旧装填

// 可注入意图：LLM 应答（reply/clarify 均走 intent=reply）与写路径（含 refused 回执——「换个项目再试」有指代价值），
// 卡片点按结果（card:*）。gate/help/bind/context 为门禁与控制命令，不进。
const injectable = (intent) => intent === 'reply' || intent?.startsWith('write:') || intent?.startsWith('card:')

/**
 * 装配某会话的可注入历史（正序返回，供 runAgentLoop 的 history 参数）。
 * @param {object} scope   { platform, chatId, chatType }（chatType=group 时 user 条目带说话人名前缀）
 * @param {object} opts    { now, turns(条数上限，≤0 关闭), idleMs(空闲窗) }
 */
export function listBotHistory(db, { platform, chatId, chatType }, { now = Date.now(), turns = 8, idleMs = 120 * 60_000 } = {}) {
  if (!chatId || turns <= 0) return []
  const watermark = db
    .prepare('SELECT MAX(cleared_at) AS t FROM bot_context_resets WHERE platform = ? AND chat_id = ?')
    .get(platform, chatId)?.t ?? 0
  const since = Math.max(Number(watermark) || 0, now - Math.max(0, idleMs))
  if (since >= now) return [] // 窗口为空（如 idleMs=0）或水位线在未来（时钟偏移）：按无历史处理
  const rows = db.prepare(
    `SELECT kind, member_id, raw_text, intent FROM bot_commands
     WHERE platform = ? AND chat_id = ? AND created_at > ? AND intent IS NOT NULL
       AND raw_text IS NOT NULL AND raw_text != ''
       AND ((kind = 'command' AND member_id IS NOT NULL AND raw_text NOT LIKE '/%') OR kind = 'bot_reply')
     ORDER BY created_at DESC, id DESC LIMIT ?`
  ).all(platform, chatId, since, FETCH_LIMIT)
  const picked = []
  let chars = 0
  for (const r of rows) {
    if (picked.length >= turns) break
    if (!injectable(r.intent)) continue
    const content = String(r.raw_text).slice(0, ENTRY_MAX_CHARS)
    if (picked.length > 0 && chars + content.length > HISTORY_CHAR_BUDGET) break // 最新一条无条件保留
    const speaker = chatType === 'group' && r.kind === 'command' && r.member_id
      ? `${db.prepare('SELECT name FROM members WHERE id = ?').get(r.member_id)?.name ?? '成员'}：`
      : ''
    picked.push({ role: r.kind === 'command' ? 'user' : 'assistant', content: speaker + content })
    chars += content.length
  }
  return picked.reverse()
}
