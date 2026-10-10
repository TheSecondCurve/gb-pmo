// 推送通道（S46，v0.51/K29）：日报/预警/梳理/建议通知经 IM 机器人下发（只发不收，不冒充成员发言）。
// v0.51 前只 INSERT pushes 表不投递（真实触达为零）；现升格为「投递 + 落库」统一层——
// 接收人有 feishu_id 且应用凭证齐备即经应用机器人 open_id 私聊真实下发（纯出站 REST，与长连接开关解耦），
// 正文复用 S45 richPost 分流 post/text。三态落行：sent（记 message_id）/ failed（记 error，
// 不抛给调用方——推送是通知语义，单个接收人失败不阻塞日报等主流程）/ skipped（error 写明原因）。
// 企微维持只落库（连接器为只读骨架，K6）。测试经 send 注入点喂假发送器（与 S34 backupFetch 同模式）。

import { camelizeRows } from '../db/index.mjs'
import { getSetting } from '../engine/settings.js'
import { richPost } from './bot/format.js'
import { sendTextToUser, sendPostToUser } from './connectors/feishu.js'

/** 默认发送器：飞书凭证齐备才可投递（否则 null → 落 skipped）。 */
function defaultSender(db) {
  const cfg = getSetting(db, 'im.feishu')
  if (!cfg.appId || !cfg.appSecret) return null
  return ({ openId, text, post }) => (post ? sendPostToUser(cfg, openId, post) : sendTextToUser(cfg, openId, text))
}

/**
 * 投递 + 落库统一入口。opts.send 注入假发送器（测试）；缺省按 im.feishu 配置走真实连接器。
 * send 载荷：{ openId, text?, post? }（post/text 二选一，post 优先），返回 { messageId }。
 */
export async function notifyMember(db, member, { pushType, title, body, projectId = null }, { send } = {}) {
  let platform = 'none'
  let status = 'skipped'
  let error = null
  let messageId = null
  if (member.feishuId) {
    platform = 'feishu'
    const sender = send || defaultSender(db)
    if (!sender) {
      error = '飞书凭证未配置（配置台「外部依赖→飞书」填 appId/appSecret 后投递）——仅落库'
    } else {
      try {
        const post = richPost(body) // 正文多行/粗体/链接 → post（标题进 post title）；单行纯文本 → text
        const r = await sender({
          openId: member.feishuId,
          post: post ? { zh_cn: { title, content: post.zh_cn.content } } : undefined,
          text: post ? undefined : `【${title}】\n${body}`,
        })
        status = 'sent'
        messageId = r?.messageId || null
      } catch (e) {
        status = 'failed'
        error = String(e?.message || e).slice(0, 500)
      }
    }
  } else if (member.wecomId) {
    platform = 'wecom'
    error = '企微推送通道未接线（会话存档连接器只读，K6）——仅落库'
  } else {
    error = '未绑定 IM 身份（无飞书/企微 id）——仅落库'
  }
  const info = db
    .prepare(
      'INSERT INTO pushes (push_type, recipient_member_id, related_project_id, title, body, channel_platform, status, error, message_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(pushType, member.id, projectId, title, body, platform, status, error, messageId, Date.now())
  return { id: Number(info.lastInsertRowid), status }
}

export async function notifyAdmins(db, payload, opts = {}) {
  const admins = camelizeRows(db.prepare(`SELECT * FROM members WHERE role = 'admin' AND status = 'active'`).all())
  const out = []
  for (const a of admins) out.push(await notifyMember(db, a, payload, opts))
  return out
}

export function listPushes(db, { recipientMemberId, limit = 100 } = {}) {
  const rows = recipientMemberId
    ? db.prepare('SELECT * FROM pushes WHERE recipient_member_id = ? ORDER BY id DESC LIMIT ?').all(recipientMemberId, limit)
    : db.prepare('SELECT * FROM pushes ORDER BY id DESC LIMIT ?').all(limit)
  return camelizeRows(rows)
}
