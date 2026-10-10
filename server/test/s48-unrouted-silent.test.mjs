import { describe, it, expect, afterAll } from 'vitest'
import { setupApp, loginCookie, authed } from './helpers.mjs'
import { createProject } from '../engine/projects.js'
import { evaluateAlerts } from '../brain/alert.js'

// PRD S48（v0.53，K31）— 未分拣池消化出口 + 沉默项目主动预警

let ctx
afterAll(() => ctx?.db.close())

function insertUnrouted(db, { content = '二期报价单客户还没回', ts = Date.now(), status = 'open' } = {}) {
  const info = db.prepare(
    'INSERT INTO unrouted_messages (platform, group_key, business_time, speaker_label, content, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run('feishu', 'oc_general', ts, '外部发言人', content, status, Date.now())
  return Number(info.lastInsertRowid)
}

describe('S48 未分拣池消化出口', () => {
  it('S48-1: 管理员可见 open 未分拣列表；普通成员 403', async () => {
    ctx = await setupApp()
    insertUnrouted(ctx.db)
    insertUnrouted(ctx.db, { content: '已处理的历史', status: 'routed' })
    const adminCookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const res = await authed(ctx.app, adminCookie, 'GET', '/api/v1/admin/unrouted')
    expect(res.status).toBe(200)
    expect(res.body.messages.length).toBe(1) // 仅 open
    expect(res.body.messages[0].content).toContain('二期报价')
    expect(res.body.messages[0].speakerLabel).toBe('外部发言人')
    expect(res.body.messages[0].groupKey).toBe('oc_general')

    const devCookie = await loginCookie(ctx.app, 'lisi', 'pass-123456')
    expect((await authed(ctx.app, devCookie, 'GET', '/api/v1/admin/unrouted')).status).toBe(403)
  })

  it('S48-2: 归挂到项目 → routed + routed_project_id，按原时刻/原文重走抽取产事件（发言人不映射成员）；非 open 409、项目不存在 404', async () => {
    const { db, members } = { db: ctx.db, members: ctx.members }
    const p = createProject(db, { name: '客户H系统', typeCode: 'lianmai_365', leadMemberId: members.lead.id }, members.admin.id)
    const msgTs = Date.now() - 86400000
    const id = insertUnrouted(db, { content: '验收推迟到下周', ts: msgTs })
    const adminCookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')

    // 归挂重走抽取（无 LLM 走确定性降级：发言人：原文 → 记录型进展事件）
    const res = await authed(ctx.app, adminCookie, 'POST', `/api/v1/admin/unrouted/${id}/route`, { projectId: p.id })
    expect(res.status).toBe(200)
    const row = db.prepare('SELECT * FROM unrouted_messages WHERE id = ?').get(id)
    expect(row.status).toBe('routed')
    expect(row.routed_project_id).toBe(p.id)
    const evts = db.prepare('SELECT * FROM project_events WHERE project_id = ?').all(p.id)
    expect(evts.some((e) => e.summary.includes('验收推迟'))).toBe(true)
    const evt = evts.find((e) => e.summary.includes('验收推迟'))
    expect(evt.speaker_member_id).toBeNull() // 池内只有标签，保守不映射成员（S3-3 同口径）
    expect(evt.speaker_label).toBe('外部发言人')
    expect(evt.business_time).toBe(msgTs) // 原消息时刻

    // 重复归挂 → 409；项目不存在 → 404
    expect((await authed(ctx.app, adminCookie, 'POST', `/api/v1/admin/unrouted/${id}/route`, { projectId: p.id })).status).toBe(409)
    const id2 = insertUnrouted(db, { content: '另一条' })
    expect((await authed(ctx.app, adminCookie, 'POST', `/api/v1/admin/unrouted/${id2}/route`, { projectId: 9999 })).status).toBe(404)
  })

  it('S48-3: 忽略 → discarded 且从 open 列表消失', async () => {
    const { db } = ctx
    const id = insertUnrouted(db, { content: '无关闲聊' })
    const adminCookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const res = await authed(ctx.app, adminCookie, 'POST', `/api/v1/admin/unrouted/${id}/discard`)
    expect(res.status).toBe(200)
    expect(db.prepare('SELECT status FROM unrouted_messages WHERE id = ?').get(id).status).toBe('discarded')
    const list = await authed(ctx.app, adminCookie, 'GET', '/api/v1/admin/unrouted')
    expect(list.body.messages.some((m) => m.id === id)).toBe(false)
  })
})

describe('S48 沉默项目预警', () => {
  it('S48-4: 沉默超阈值项目推牵头人+管理员；同窗口节流不重复；活跃项目不预警', async () => {
    const { db, members } = (() => { return { db: ctx.db, members: ctx.members } })()
    // 沉默项目：立项事件与任务更新压到 10 天前（默认 silentDays=7）
    const silent = createProject(db, { name: '沉默的项目', typeCode: 'lianmai_365', leadMemberId: members.lead.id }, members.admin.id)
    const old = Date.now() - 10 * 86400000
    db.prepare('UPDATE project_events SET business_time = ? WHERE project_id = ?').run(old, silent.id)
    db.prepare('UPDATE tasks SET updated_at = ? WHERE project_id = ?').run(old, silent.id)
    // 活跃项目：昨天有已生效事件（S48-2 归挂产生的验收事件恰在昨天，复用客户H系统）
    const active = db.prepare('SELECT id FROM projects WHERE name = ?').get('客户H系统')

    const sendCalls = []
    const fakeSend = async (m) => { sendCalls.push(m); return { messageId: 'om_s' } }
    const { alerts } = await evaluateAlerts(db, { send: fakeSend })
    const silentAlert = alerts.find((a) => a.type === 'silent_project' && a.projectId === silent.id)
    expect(silentAlert).toBeTruthy()
    expect(alerts.some((a) => a.type === 'silent_project' && a.projectId === active.id)).toBe(false)
    // 牵头人（lead，有飞书）真实投递 + 管理员（无 IM）skipped 落行
    const pushRows = db.prepare(`SELECT * FROM pushes WHERE push_type = 'alert' AND title LIKE '沉默项目预警%'`).all()
    expect(pushRows.length).toBe(2)
    expect(pushRows.some((r) => r.recipient_member_id === members.lead.id && r.status === 'sent')).toBe(true)
    expect(pushRows.some((r) => r.recipient_member_id === members.admin.id && r.status === 'skipped')).toBe(true)
    expect(pushRows[0].body).toContain('沉默的项目')

    // 同窗口重复巡检 → 节流不再推
    const again = await evaluateAlerts(db, { send: fakeSend })
    expect(again.alerts.some((a) => a.type === 'silent_project' && a.projectId === silent.id)).toBe(false)
    const pushRows2 = ctx.db.prepare(`SELECT * FROM pushes WHERE push_type = 'alert' AND title LIKE '沉默项目预警%'`).all()
    expect(pushRows2.length).toBe(2)
  })

  it('S48-4: 沉默预警以交互卡片送达——橙色 header 含项目名与沉默天数（v0.63）', async () => {
    const { db, members } = ctx
    // 另起一个沉默项目（上一用例的同项目已被节流），牵头人张三有飞书绑定
    const silent2 = createProject(db, { name: '沉默的项目乙', typeCode: 'lianmai_365', leadMemberId: members.lead.id }, members.admin.id)
    const old = Date.now() - 10 * 86400000
    db.prepare('UPDATE project_events SET business_time = ? WHERE project_id = ?').run(old, silent2.id)
    db.prepare('UPDATE tasks SET updated_at = ? WHERE project_id = ?').run(old, silent2.id)

    const sent = []
    await evaluateAlerts(db, { send: async (m) => { sent.push(m); return { messageId: 'om_c' } } })
    const toLead = sent.find((m) => m.openId === 'fs_zhang' && m.card?.header?.title?.content === '沉默项目预警：沉默的项目乙')
    expect(toLead).toBeTruthy()
    expect(toLead.card.header.template).toBe('orange')
    expect(JSON.stringify(toLead.card)).toContain('已连续')
  })
})
