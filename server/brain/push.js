// 推送通道：日报/预警/梳理经 IM 机器人下发（只发不收，不冒充成员发言）。
// IM webhook 未配置时记录 pushes 行并标 skipped——测试与内网首启都能断言内容。

import { camelizeRows } from '../db/index.mjs'

export function notifyMember(db, member, { pushType, title, body, projectId = null }) {
  const platform = member.feishuId ? 'feishu' : member.wecomId ? 'wecom' : 'none'
  const info = db
    .prepare(
      'INSERT INTO pushes (push_type, recipient_member_id, related_project_id, title, body, channel_platform, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(pushType, member.id, projectId, title, body, platform, platform === 'none' ? 'skipped' : 'sent', Date.now())
  return { id: Number(info.lastInsertRowid), status: platform === 'none' ? 'skipped' : 'sent' }
}

export function notifyAdmins(db, payload) {
  const admins = camelizeRows(db.prepare(`SELECT * FROM members WHERE role = 'admin' AND status = 'active'`).all())
  return admins.map((a) => notifyMember(db, a, payload))
}

export function listPushes(db, { recipientMemberId, limit = 100 } = {}) {
  const rows = recipientMemberId
    ? db.prepare('SELECT * FROM pushes WHERE recipient_member_id = ? ORDER BY id DESC LIMIT ?').all(recipientMemberId, limit)
    : db.prepare('SELECT * FROM pushes ORDER BY id DESC LIMIT ?').all(limit)
  return camelizeRows(rows)
}
