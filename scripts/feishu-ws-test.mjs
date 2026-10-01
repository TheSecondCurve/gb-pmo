// 飞书长连接独立诊断脚本（不依赖 pmo 进程）。
// 分三段定位「机器人不应答」断在哪一环：
//   ① tenant_access_token：验证 appId/appSecret 与到 open.feishu.cn 的网络
//   ② WSClient 长连接握手：验证官方 SDK 能否建立 wss 通道（autoReconnect=false 快速失败）
//   ③ 接收消息事件：脚本挂着期间去飞书私聊机器人发一句话，收到即全链路通
// 用法（任选一种凭证来源，优先级：命令行 > 环境变量 > --db 读 settings 表）：
//   node scripts/feishu-ws-test.mjs --app-id cli_xxx --app-secret xxx
//   FEISHU_APP_ID=cli_xxx FEISHU_APP_SECRET=xxx node scripts/feishu-ws-test.mjs
//   node scripts/feishu-ws-test.mjs --db data/gb-pmo.db [--wait 30]

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]
    if (k === '--app-id') out.appId = argv[++i]
    else if (k === '--app-secret') out.appSecret = argv[++i]
    else if (k === '--db') out.db = argv[++i]
    else if (k === '--wait') out.wait = Number(argv[++i])
  }
  return out
}

function mask(s) {
  if (!s) return '(空)'
  return s.length <= 8 ? `${s.slice(0, 2)}**` : `${s.slice(0, 6)}...${s.slice(-4)}`
}

async function loadCfg() {
  const args = parseArgs(process.argv.slice(2))
  let appId = args.appId || process.env.FEISHU_APP_ID || ''
  let appSecret = args.appSecret || process.env.FEISHU_APP_SECRET || ''
  if (!appId || !appSecret) {
    const dbFile = args.db || process.env.GB_PMO_DB || path.join(process.cwd(), 'data/gb-pmo.db')
    if (!fs.existsSync(dbFile)) {
      console.error(`未提供凭证，且数据库不存在：${dbFile}`)
      console.error('请用 --app-id/--app-secret 或 FEISHU_APP_ID/FEISHU_APP_SECRET 提供，或 --db 指向部署库。')
      process.exit(2)
    }
    const { default: Database } = await import('better-sqlite3')
    const db = new Database(dbFile, { readonly: true })
    const row = db.prepare("SELECT value FROM settings WHERE key = 'im.feishu'").get()
    db.close()
    if (!row) {
      console.error(`数据库 ${dbFile} 中没有 im.feishu 配置（配置台从未保存过飞书凭证）。`)
      process.exit(2)
    }
    const cfg = JSON.parse(row.value)
    appId = appId || cfg.appId || ''
    appSecret = appSecret || cfg.appSecret || ''
  }
  return { appId, appSecret, waitSec: args.wait || 30 }
}

// ① 凭证 + 网络：不经过 SDK，裸 fetch，失败信息最原始
async function checkToken({ appId, appSecret }) {
  console.log(`\n[①] 获取 tenant_access_token（appId=${mask(appId)}）...`)
  const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  })
  const data = await res.json()
  if (data.code !== 0) {
    console.error(`[①] 失败：code=${data.code} msg=${data.msg}`)
    console.error('    → appId/appSecret 错误，或本机到 open.feishu.cn 网络不通（代理/防火墙）。长连接不用再测。')
    process.exit(1)
  }
  console.log('[①] 通过：凭证有效，open.feishu.cn 可达')
}

// ② + ③ 长连接握手与事件接收
async function checkWs(cfg) {
  const sdk = (await import('@larksuiteoapi/node-sdk')).default ?? (await import('@larksuiteoapi/node-sdk'))
  console.log('\n[②] 建立 WebSocket 长连接（官方 SDK，autoReconnect=false）...')
  let gotEvent = false
  const dispatcher = new sdk.EventDispatcher({}).register({
    'im.message.receive_v1': async (data) => {
      gotEvent = true
      const msg = data?.event?.message || {}
      const text = String(JSON.parse(msg.content || '{}').text || '')
      console.log(`[③] 收到消息事件！type=${msg.message_type} chat=${msg.chat_type} text="${text.slice(0, 50)}"`)
      console.log('[③] 全链路通：飞书 → 长连接 → 本机。pmo 网关用同一套 SDK 用法，此处通即代码无问题。')
      setTimeout(() => process.exit(0), 500)
    },
  })
  const ws = new sdk.WSClient({
    appId: cfg.appId,
    appSecret: cfg.appSecret,
    loggerLevel: 'info',
    autoReconnect: false,
    handshakeTimeoutMs: 15000,
    onReady: () => console.log(`[②] 长连接已建立。请在 ${cfg.waitSec}s 内用飞书私聊这个机器人发一句话（如「你好」）...`),
    onError: (err) => {
      console.error(`[②] 长连接失败：${err.message}`)
      console.error('    → 凭证①已通过，此处失败常见原因：开发者后台「事件与回调」订阅方式未选「使用长连接接收事件」；')
      console.error('      或应用未发布版本（开发版仅开发者可用）；或企业网络拦截 wss。见 PRD 附录 A.1。')
      process.exit(1)
    },
  })
  await ws.start({ eventDispatcher: dispatcher })
  const deadline = Date.now() + cfg.waitSec * 1000
  while (Date.now() < deadline) {
    if (gotEvent) return
    await new Promise((r) => setTimeout(r, 500))
  }
  const status = typeof ws.getConnectionStatus === 'function' ? ws.getConnectionStatus() : { state: 'unknown' }
  console.error(`\n[③] ${cfg.waitSec}s 内未收到任何消息事件（连接状态：${status.state}）。`)
  console.error('    → 长连接本身是通的，事件没到 = 飞书后台问题，依次检查：')
  console.error('      a. 「事件与回调」已订阅「接收消息 v2.0」（im.message.receive_v1）且订阅方式为长连接；')
  console.error('      b. 已开通权限 im:message.p2p_msg:readonly（收私聊）并已【发布版本】生效；')
  console.error('      c. 发消息的人在应用「可用范围」内（230013）；')
  console.error('      d. 私聊的是这个 appId 对应的机器人（同名自建应用可能不止一个）。')
  process.exit(1)
}

const cfg = await loadCfg()
console.log('飞书机器人长连接诊断（gb-pmo S20）')
await checkToken(cfg)
await checkWs(cfg)
