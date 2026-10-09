// S20 网关：飞书事件长连接（@larksuiteoapi/node-sdk 懒加载）。纯接线层——
// 全部逻辑在 command.js（测试直调 handleBotEvent/handleCardAction，不经此文件）。
// botEnabled 未开启 / 凭证未配 / SDK 未安装时明确提示并跳过，不阻塞主进程（K9）。
// S20-12（v0.22）：syncBot 支持热重启——配置台保存 im.feishu 即按新配置重连/断开，
// 无需重启进程（与 v0.15「配置生效无需重启」原则对齐）；热同步串行化防并发交错。

import { getSetting } from '../../engine/settings.js'
import * as feishu from '../connectors/feishu.js'
import { handleBotEvent, handleCardAction } from './command.js'

let currentWs = null
let syncChain = Promise.resolve()

/** 热同步长连接：按当前 im.feishu 配置重算（旧连接先断，开启且凭证齐全则重建）。connect 注入点供测试。 */
export function syncBot(db, opts = {}) {
  const run = syncChain.then(() => doSync(db, opts))
  syncChain = run.catch(() => {})
  return run
}

async function doSync(db, { secret, connect } = {}) {
  const cfg = getSetting(db, 'im.feishu')
  await stopBot()
  if (!cfg.botEnabled) return { started: false, reason: 'botEnabled 未开启（配置台 im.feishu）' }
  if (!cfg.appId || !cfg.appSecret) return { started: false, reason: '未配置 appId/appSecret' }
  try {
    const { ws, result } = connect ? await connect(cfg) : await connectReal(db, cfg, secret)
    currentWs = ws ?? null
    return result ?? { started: true }
  } catch (e) {
    return { started: false, reason: `启动失败：${e.message}` }
  }
}

/** 断开当前长连接（幂等）。 */
export function stopBot() {
  const old = currentWs
  currentWs = null
  try { old?.close?.() } catch { /* 已关闭 */ }
  return Boolean(old)
}

/**
 * SDK 1.74 EventDispatcher 直接传入解包后的事件体 {sender, message}（见官方 README）；
 * 兼容带 event 包络的形态。此前只取 data.event.message 恒为空，导致所有入站消息
 * 在审计落库前被静默丢弃（线上实测发现，S20-12 排障根因）。
 */
export function parseSdkMessage(data) {
  const body = data?.event && (data.event.message || data.event.sender) ? data.event : data
  return {
    msg: body?.message || {},
    senderOpenId: body?.sender?.sender_id?.open_id || body?.sender?.open_id || '',
  }
}

/**
 * S20-20（v0.37）：入站消息 → 纯文本。text 原样；post（富文本）按段落拍平——text/a 取文字、
 * at 渲染 @名字（缺省 @用户）、img 以 [图片] 占位、段落换行连接、非空 title 置顶；其余消息类型
 * 与非法 content 返回 ''（调用方按空文本静默忽略）。线上实测：飞书输入框把 "- " 列表行自动
 * 转 post，此前网关只认 text，此类消息在审计前被静默丢弃（零回复零痕迹）。
 */
export function extractMessageText(messageType, content) {
  let parsed
  try { parsed = JSON.parse(content || '{}') } catch { return '' }
  if (messageType === 'text') return String(parsed.text || '')
  if (messageType !== 'post' || !Array.isArray(parsed.content)) return ''
  const paragraphs = parsed.content.map((els) =>
    (Array.isArray(els) ? els : []).map((e) => {
      if (e?.tag === 'text' || e?.tag === 'a') return String(e.text || '')
      if (e?.tag === 'at') return e.user_name ? `@${e.user_name}` : '@用户'
      if (e?.tag === 'img') return '[图片]'
      return ''
    }).join(''))
  const title = String(parsed.title || '').trim()
  return (title ? `${title}\n` : '') + paragraphs.join('\n')
}

/**
 * 群消息 @ 判定（S20-16/v0.26.1）：应用持有 im:message.group_msg 时事件订阅推送群内全部消息，
 * 必须 @ 本机器人才处理。私聊恒真；有机器人身份（open_id）时比对 mentions（@ 其他人不算）；
 * 身份获取失败降级要求消息带 @_user_N 占位前缀（宁可不答不可乱答）。
 */
export function resolveMention({ chatType, mentions, rawText, botOpenId }) {
  if (chatType !== 'group') return true
  if (botOpenId) return (mentions || []).some((m) => m?.id?.open_id === botOpenId)
  return /^@_user_\d+/.test(String(rawText || '').trim())
}

async function connectReal(db, cfg, secret) {
  let sdk
  try {
    sdk = await import('@larksuiteoapi/node-sdk')
  } catch {
    console.warn('[bot] 未安装 @larksuiteoapi/node-sdk，机器人未启动。安装：npm i @larksuiteoapi/node-sdk（PRD 附录 A.1 第 7 步）')
    return { result: { started: false, reason: 'sdk-missing' } }
  }

  const externalCache = new Map()
  // 外部群判定失败时按外部群拒收（fail-closed：安全不变量优先，S20-7）
  async function isExternal(chatId, chatType) {
    if (chatType !== 'group') return false
    if (externalCache.has(chatId)) return externalCache.get(chatId)
    let external
    try {
      const chat = await feishu.getChat(cfg, chatId)
      external = Boolean(chat.external)
    } catch {
      external = true
    }
    externalCache.set(chatId, external)
    return external
  }

  // 机器人自身身份（S20-16）：连接时取一次，用于群消息 @ 判定；失败不阻塞连接（降级判定）
  let botOpenId = null
  try {
    botOpenId = (await feishu.getBotInfo(cfg)).openId
  } catch (e) {
    console.warn(`[bot] 机器人身份获取失败（群消息降级为占位前缀判定）: ${e.message}`)
  }

  // S45：send 按载荷类型分流——card=消息卡片、post=富文本、text=纯文本；patch 同型编辑（text/post）
  const send = ({ chatId, text, post, card }) =>
    (card ? feishu.sendCard(cfg, chatId, card) : post ? feishu.sendPost(cfg, chatId, post) : feishu.sendText(cfg, chatId, text))
  // S20-19 私聊占位反馈的编辑通道：把占位消息原地替换为最终答复（应用需 im:message:update 权限，缺权限时运行时降级另发新消息）
  const patch = ({ messageId, text, post }) => (post ? feishu.patchPost(cfg, messageId, post) : feishu.patchText(cfg, messageId, text))

  const dispatcher = new sdk.EventDispatcher({}).register({
    'im.message.receive_v1': async (data) => {
      try {
        const { msg, senderOpenId } = parseSdkMessage(data)
        // S20-20：text 原样、post（富文本）按段落拍平；其余类型/拍平为空返回 ''，由下方空判定统一静默忽略
        const rawText = extractMessageText(msg.message_type, msg.content)
        const chatType = msg.chat_type === 'p2p' ? 'p2p' : 'group'
        // 群@消息文本带 @_user_N 前缀，剥掉再交给指令层；群消息必须 @ 本机器人（S20-16）
        const text = rawText.replace(/^@\S+\s*/, '').trim()
        if (!text) return
        await handleBotEvent(db, {
          messageId: msg.message_id,
          chatId: msg.chat_id,
          chatType,
          senderOpenId,
          text,
          ts: Date.now(),
          external: await isExternal(msg.chat_id, chatType),
          mentioned: resolveMention({ chatType, mentions: msg.mentions, rawText, botOpenId }),
        }, { send, patch, secret })
      } catch (e) {
        console.error('[bot] 消息处理失败:', e.message)
      }
    },
    'card.action.trigger': async (data) => {
      try {
        const ev = data?.event || data || {}
        await handleCardAction(db, {
          operatorOpenId: ev.operator?.open_id || ev.operator?.operator_id?.open_id || '',
          value: ev.action?.value || {},
          chatId: ev.context?.open_chat_id || '',
          messageId: ev.context?.open_message_id || null,
        }, { send, secret })
      } catch (e) {
        console.error('[bot] 卡片回调处理失败:', e.message)
      }
    },
  })

  // SDK 语义（1.74 源码，同 selfCheck）：握手失败时 start() 也正常 resolve、错误走 onError——
  // 保存回显必须等真实握手信号，否则凭证错误也会回「已建立」假阳性（S20-12）
  const verdict = await new Promise((resolve) => {
    const ws = new sdk.WSClient({
      appId: cfg.appId, appSecret: cfg.appSecret, loggerLevel: 'warn',
      onReady: () => resolve({ ok: true, ws }),
      onError: (err) => resolve({ ok: false, err, ws }),
    })
    ws.start({ eventDispatcher: dispatcher }).catch((err) => resolve({ ok: false, err, ws }))
    setTimeout(() => resolve({ ok: null, ws }), 10_000) // 超时不定论：连接保留，回显降级提示
  })
  if (verdict.ok === false) {
    try { verdict.ws?.close?.() } catch { /* 已关闭 */ }
    return { result: { started: false, reason: `长连接握手失败：${verdict.err?.message || String(verdict.err)}（检查 appId/appSecret、事件订阅方式是否选长连接、应用是否已发布版本）` } }
  }
  if (verdict.ok === true) {
    console.log('[bot] 飞书长连接已启动（私聊/群@ 指令 + 卡片确认；订阅与权限见 PRD 附录 A.1 第 7 步）')
    return { ws: verdict.ws, result: { started: true } }
  }
  // 超时不定论：连接保留（SDK 内部自动重试），回显降级提示
  console.warn('[bot] 长连接握手确认超时（10s），保留连接并由 SDK 自动重试；如持续无响应请跑运维诊断自检')
  return { ws: verdict.ws, result: { started: true, note: '连接已发起，握手确认超时（10s）；如私聊无响应，请用「测试连接」或运维诊断自检复核' } }
}
