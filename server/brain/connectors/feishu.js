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
  if (data.code !== 0) throw Object.assign(new Error(`飞书 token 失败(${data.code}): ${data.msg}`), { statusCode: 502 })
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
    if (data.code !== 0) throw Object.assign(new Error(`飞书消息失败(${data.code}): ${data.msg}`), { statusCode: 502 })
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

// —— S26（v0.19）诊断台：长连接三段自检 ——

// ①凭证/网络 → ②WSClient 握手 → ③事件接收为人工段（回检查清单）。
// 未配置凭证时①即返回指引，不发外网；②用空分发器只验握手（autoReconnect=false 快速失败）。
export async function selfCheck(cfg, { waitMs = 8000 } = {}) {
  const stages = []
  if (!cfg.appId || !cfg.appSecret) {
    return { ok: false, stages: [{ stage: 'token', ok: false, reason: '未配置 appId/appSecret：请在配置台「外部依赖→飞书」保存凭证（附录 A.1）' }] }
  }
  try {
    await tenantToken(cfg)
    stages.push({ stage: 'token', ok: true, note: '凭证有效，open.feishu.cn 可达' })
  } catch (e) {
    return { ok: false, stages: [...stages, { stage: 'token', ok: false, reason: `${e.message}（appId/appSecret 错误或容器网络不通）` }] }
  }
  let sdk
  try {
    sdk = await import('@larksuiteoapi/node-sdk')
  } catch {
    return { ok: false, stages: [...stages, { stage: 'ws', ok: false, reason: '未安装 @larksuiteoapi/node-sdk（npm i 后重启进程）' }] }
  }
  const mod = sdk.default ?? sdk
  // SDK 语义（1.74 源码）：握手失败时 start() 正常 resolve、错误走 onError 回调，
  // 成功走 onReady——所以信号源必须是回调，不能依赖 promise reject 路径。
  const verdict = await new Promise((resolve) => {
    const ws = new mod.WSClient({
      appId: cfg.appId, appSecret: cfg.appSecret, loggerLevel: 'warn',
      autoReconnect: false, handshakeTimeoutMs: 15000,
      onReady: () => resolve({ ok: true, ws }),
      onError: (err) => resolve({ ok: false, reason: err?.message || String(err), ws }),
    })
    ws.start({ eventDispatcher: new mod.EventDispatcher({}) }).catch((err) => resolve({ ok: false, reason: err?.message || String(err), ws }))
    setTimeout(() => resolve({ ok: false, reason: `握手超时（${waitMs}ms 无结果）`, ws }), waitMs)
  })
  try { verdict.ws?.close?.() } catch { /* 已关闭 */ }
  if (!verdict.ok) {
    return { ok: false, stages: [...stages, { stage: 'ws', ok: false, reason: `长连接握手失败：${verdict.reason}（检查：事件与回调是否选「使用长连接接收事件」；应用是否已发布版本）` }] }
  }
  stages.push({
    stage: 'ws', ok: true,
    note: '长连接握手成功。第③段（收消息）需人工验证：私聊机器人发一句话应答即通；不通时依次检查——「接收消息 v2.0」事件已订阅（长连接方式）、im:message.p2p_msg:readonly 已开通并发布版本、发消息人在应用可用范围内。',
  })
  return { ok: true, stages }
}

// —— S20 机器人指令通道：以应用身份发消息/卡片 + 读群信息（判定外部群） ——

async function postMessage(cfg, receiveIdType, receiveId, msgType, content) {
  const token = await tenantToken(cfg)
  const res = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ receive_id: receiveId, msg_type: msgType, content: JSON.stringify(content) }),
  })
  if (!res.ok) throw Object.assign(new Error(`飞书发送 HTTP ${res.status}`), { statusCode: 502 })
  const data = await res.json()
  if (data.code !== 0) throw Object.assign(new Error(`飞书发送失败(${data.code}): ${data.msg}`), { statusCode: 502 })
  return { messageId: data.data?.message_id || null }
}

/** 发文本（chat_id 定向：私聊会话与群均适用）。注意 receive_id_type 合法值是 chat_id，
 *  不是消息拉取接口的 container_id_type=chat——此前误传 'chat' 被飞书拒参，所有机器人回复发送失败（S20 排障）。 */
export async function sendText(cfg, chatId, text) {
  return postMessage(cfg, 'chat_id', chatId, 'text', { text })
}

/** 发消息卡片（S20 确认卡）。 */
export async function sendCard(cfg, chatId, card) {
  return postMessage(cfg, 'chat_id', chatId, 'interactive', card)
}

/** 群信息（external 字段用于 S20-7 外部群拒答；调用方负责缓存）。 */
export async function getChat(cfg, chatId) {
  const token = await tenantToken(cfg)
  const res = await fetch(`https://open.feishu.cn/open-apis/im/v1/chats/${chatId}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw Object.assign(new Error(`飞书群信息 HTTP ${res.status}`), { statusCode: 502 })
  const data = await res.json()
  if (data.code !== 0) throw Object.assign(new Error(`飞书群信息失败(${data.code}): ${data.msg}`), { statusCode: 502 })
  return data.data || {}
}

// —— S22 项目日历：应用身份维护组织级日历与全日事件（calendar/v4，PRD §7.6）——

async function callApi(cfg, path, method, body) {
  const token = await tenantToken(cfg)
  const res = await fetch(`https://open.feishu.cn/open-apis${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) {
    // 非 2xx 时飞书也在响应体里给 code/msg（如 400 field validation failed）——读出来别丢（S22-6）
    let detail = ''
    try {
      const j = await res.json()
      if (j && (j.code !== undefined || j.msg)) detail = `(${j.code ?? ''}): ${j.msg || ''}`
    } catch { /* 非 JSON 响应体，仅回状态码 */ }
    throw Object.assign(new Error(`飞书日历 HTTP ${res.status}${detail}`), { statusCode: 502 })
  }
  const data = await res.json()
  if (data.code !== 0) throw Object.assign(new Error(`飞书日历失败(${data.code}): ${data.msg}`), { statusCode: 502 })
  return data.data || {}
}

/**
 * 创建组织级日历（组织内可搜索订阅）。v0.21：飞书 v4 的 permissions 已改枚举字符串
 * （private / show_only_free_busy / public），旧对象格式（share_tenant_permission 等）被 400 拒绝；
 * public = 组织内可搜索订阅、他人可查看日程详情（PRD §7.6 语义）。
 * 返回 { calendarId }。
 */
export async function createCalendar(cfg, { summary, description }) {
  const data = await callApi(cfg, '/calendar/v4/calendars', 'POST', {
    summary, description,
    permissions: 'public',
  })
  return { calendarId: data.calendar?.calendar_id || null }
}

/** 全日事件时间体：飞书全天日程起止=首日/末日（闭区间，单日两者相同）。 */
const allDay = (day) => ({ date: day, timestamp: '' })

/** 在日历上创建全日事件，返回 { eventId }。content = { summary, description, startDay, endDay }。 */
export async function createEvent(cfg, calendarId, content) {
  const data = await callApi(cfg, `/calendar/v4/calendars/${calendarId}/events`, 'POST', {
    summary: content.summary,
    description: content.description,
    start_time: allDay(content.startDay),
    end_time: allDay(content.endDay),
    need_notification: false,
  })
  return { eventId: data.event?.event_id || null }
}

/** 更新既有全日事件（对账 hash 变化时 patch 同一 event_id）。 */
export async function patchEvent(cfg, calendarId, eventId, content) {
  await callApi(cfg, `/calendar/v4/calendars/${calendarId}/events/${eventId}`, 'PATCH', {
    summary: content.summary,
    description: content.description,
    start_time: allDay(content.startDay),
    end_time: allDay(content.endDay),
  })
  return { eventId }
}
