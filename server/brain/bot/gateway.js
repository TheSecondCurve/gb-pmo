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
    let external = true
    try {
      const chat = await feishu.getChat(cfg, chatId)
      external = Boolean(chat.external)
    } catch {
      external = true
    }
    externalCache.set(chatId, external)
    return external
  }

  const send = ({ chatId, text, card }) => (card ? feishu.sendCard(cfg, chatId, card) : feishu.sendText(cfg, chatId, text))

  const dispatcher = new sdk.EventDispatcher({}).register({
    'im.message.receive_v1': async (data) => {
      try {
        const msg = data?.event?.message || {}
        if (msg.message_type !== 'text') return
        const chatType = msg.chat_type === 'p2p' ? 'p2p' : 'group'
        // 群@消息文本带 @_user_N 前缀，剥掉再交给指令层
        const text = String(JSON.parse(msg.content || '{}').text || '')
          .replace(/^@\S+\s*/, '').trim()
        if (!text) return
        await handleBotEvent(db, {
          messageId: msg.message_id,
          chatId: msg.chat_id,
          chatType,
          senderOpenId: data?.event?.sender?.sender_id?.open_id || '',
          text,
          ts: Date.now(),
          external: await isExternal(msg.chat_id, chatType),
        }, { send, secret })
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
