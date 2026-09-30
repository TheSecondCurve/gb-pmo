// 飞书连接器：自建应用 + 机器人进群 + 历史消息 API（PRD 附录 A.1）。
// GET /open-apis/im/v1/messages?container_id=<chat_id>，tenant_access_token 鉴权，按创建时间升序分页。

async function tenantToken(cfg) {
  const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app_id: cfg.appId, app_secret: cfg.appSecret }),
  })
  if (!res.ok) throw Object.assign(new Error(`飞书 token HTTP ${res.status}`), { statusCode: 502 })
  const data = await res.json()
  if (data.code !== 0) throw Object.assign(new Error(`飞书 token 失败: ${data.msg}`), { statusCode: 502 })
  return data.tenant_access_token
}

function normalizeText(item) {
  const msgType = item.msg_type
  try {
    if (msgType === 'text') return JSON.parse(item.body?.content || '{}').text || ''
    if (msgType === 'post') return extractPostText(JSON.parse(item.body?.content || '{}'))
    if (msgType === 'interactive') return (JSON.parse(item.body?.content || '{}').elements || []).map((e) => e.text?.text || e.tag || '').join(' ').slice(0, 2000)
  } catch {
    /* 原样降级 */
  }
  return item.body?.content ? String(item.body.content).slice(0, 2000) : ''
}

function extractPostText(content) {
  const out = []
  for (const lang of Object.values(content || {})) {
    if (!lang) continue
    if (lang.title) out.push(lang.title)
    if (lang.content) {
      for (const para of lang.content) (para || []).forEach((run) => out.push(run?.text || ''))
    }
  }
  return out.join(' ').slice(0, 2000)
}

/**
 * 增量拉取一个群的消息。cursor = 上一批最后一条消息的创建时间（秒）。
 * 返回 { messages: [{ id, speakerId, text, ts(ms) }], nextCursor }
 */
export async function fetchMessages(cfg, channel, cursor) {
  const token = await tenantToken(cfg)
  const start = cursor ? Number(cursor) + 1 : Math.floor(Date.now() / 1000) - 7 * 86400
  const end = Math.floor(Date.now() / 1000)
  const messages = []
  let pageToken = ''
  let lastSec = 0
  do {
    const url = new URL('https://open.feishu.cn/open-apis/im/v1/messages')
    url.searchParams.set('container_id', channel.groupKey)
    url.searchParams.set('container_id_type', 'chat')
    url.searchParams.set('start_time', String(start))
    url.searchParams.set('end_time', String(end))
    url.searchParams.set('sort_type', 'ByCreateTimeAsc')
    url.searchParams.set('page_size', '50')
    if (pageToken) url.searchParams.set('page_token', pageToken)
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } })
    if (!res.ok) throw Object.assign(new Error(`飞书消息 HTTP ${res.status}`), { statusCode: 502 })
    const data = await res.json()
    if (data.code !== 0) throw Object.assign(new Error(`飞书消息失败: ${data.msg}`), { statusCode: 502 })
    for (const item of data.data?.items || []) {
      const sec = Number(item.create_time)
      messages.push({
        id: item.message_id,
        speakerId: item.sender?.id || '',
        text: normalizeText(item),
        ts: sec * 1000,
      })
      lastSec = Math.max(lastSec, sec)
    }
    pageToken = data.data?.has_more ? data.data?.page_token : ''
  } while (pageToken)
  // 无新消息时游标推进到本次窗口终点，避免下次重复拉空窗口
  return { messages, nextCursor: String(messages.length ? lastSec : end) }
}

export async function testConnection(cfg) {
  if (!cfg.appId || !cfg.appSecret) return { ok: false, reason: '未配置 appId/appSecret（申请流程见 PRD 附录 A.1）' }
  try {
    await tenantToken(cfg)
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: e.message }
  }
}
