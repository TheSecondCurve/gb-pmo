import { describe, it, expect, afterAll } from 'vitest'
import { setupApp, setupDb, seedMembers, loginCookie, authed } from './helpers.mjs'
import { notifyMember, listPushes } from '../brain/push.js'
import { dailyReport } from '../brain/report.js'
import { evaluateAlerts } from '../brain/alert.js'
import { pushSuggestion } from '../brain/extract.js'
import { createMember } from '../engine/members.js'
import { createProject } from '../engine/projects.js'
import { addEvent } from '../engine/events.js'
import { today, addDays } from '../db/time.js'

// PRD S46（v0.51，K29）— 推送链路真实投递 + web 通知收件箱：
// notifyMember 升格为「投递+落库」统一层（飞书 open_id 私聊，post/text 分流，三态落行 sent/failed/skipped）；
// web 收件箱 #/pushes 仅本人可见。企微维持只落库。

let db
afterAll(() => db?.close())

describe('S46 推送链路真实投递', () => {
  it('S46-1: 已绑定飞书且凭证齐备 → open_id 私聊真实投递；sent 落 message_id；多行正文走 post、单行走 text', async () => {
    ;({ db } = setupDb())
    const m = createMember(db, { name: '飞飞', username: 'fei', password: 'p', feishuId: 'ou_fei' }, 1)
    const calls = []
    const fakeSend = async (msg) => { calls.push(msg); return { messageId: 'om_x1' } }

    await notifyMember(db, m, { pushType: 'alert', title: '逾期任务预警：飞飞', body: '你有 2 项逾期未完任务：\n- 任务A\n- 任务B' }, { send: fakeSend })
    const row = db.prepare('SELECT * FROM pushes WHERE recipient_member_id = ?').get(m.id)
    expect(row.status).toBe('sent')
    expect(row.message_id).toBe('om_x1')
    expect(row.error).toBeNull()
    expect(row.channel_platform).toBe('feishu')
    expect(calls[0].openId).toBe('ou_fei') // receive_id_type=open_id 私聊
    expect(calls[0].post).toBeTruthy() // 多行正文 → post 富文本
    expect(calls[0].post.zh_cn.title).toContain('逾期任务预警')
    expect(calls[0].text).toBeUndefined()

    await notifyMember(db, m, { pushType: 'test', title: '测试', body: '单行内容' }, { send: fakeSend })
    expect(calls[1].text).toContain('测试')
    expect(calls[1].text).toContain('单行内容')
    expect(calls[1].post).toBeUndefined() // 单行纯文本维持 text
    const row2 = db.prepare('SELECT * FROM pushes WHERE push_type = ?').get('test')
    expect(row2.status).toBe('sent')
  })

  it('S46-2: 投递失败 → failed + error 落行，不抛给调用方；其余接收人不受影响', async () => {
    ;({ db } = setupDb())
    const members = seedMembers(db)
    const calls = []
    const badSend = async (msg) => {
      if (msg.openId === 'fs_zhang') throw new Error('飞书发送失败(230002): bot is not in the chat')
      calls.push(msg)
      return { messageId: 'om_ok' }
    }
    // 单条失败不抛
    await notifyMember(db, members.lead, { pushType: 'alert', title: 't', body: 'b' }, { send: badSend })
    const failRow = db.prepare('SELECT * FROM pushes WHERE recipient_member_id = ?').get(members.lead.id)
    expect(failRow.status).toBe('failed')
    expect(failRow.error).toContain('230002')
    // 其余接收人正常送达
    await notifyMember(db, members.dev, { pushType: 'alert', title: 't', body: 'b' }, { send: badSend })
    const okRow = db.prepare('SELECT * FROM pushes WHERE recipient_member_id = ?').get(members.dev.id)
    expect(okRow.status).toBe('sent')
    expect(okRow.message_id).toBe('om_ok')
    // 主流程（日报）不因单个接收人投递失败而中断
    const out = await dailyReport(db, { force: true, send: badSend })
    expect(out.reports).toBe(4)
    const reportRows = db.prepare(`SELECT * FROM pushes WHERE push_type = 'daily_report'`).all()
    expect(reportRows.length).toBe(4)
    expect(reportRows.find((r) => r.recipient_member_id === members.lead.id).status).toBe('failed')
    expect(reportRows.find((r) => r.recipient_member_id === members.dev.id).status).toBe('sent')
  })

  it('S46-3: 无 IM 身份 / 飞书未配置 / 企微成员 → skipped 且 error 写明原因', async () => {
    ;({ db } = setupDb())
    const plain = createMember(db, { name: '无', username: 'wu', password: 'p' }, 1)
    const fei = createMember(db, { name: '飞', username: 'fei2', password: 'p', feishuId: 'ou_f2' }, 1)
    const wk = createMember(db, { name: '企', username: 'qi', password: 'p', wecomId: 'wk_q' }, 1)

    await notifyMember(db, plain, { pushType: 'test', title: 't', body: 'b' })
    await notifyMember(db, fei, { pushType: 'test', title: 't', body: 'b' }) // 无注入 send 且库内无飞书配置
    await notifyMember(db, wk, { pushType: 'test', title: 't', body: 'b' })
    const rows = listPushes(db)
    expect(rows.find((r) => r.recipientMemberId === plain.id).status).toBe('skipped')
    expect(rows.find((r) => r.recipientMemberId === plain.id).error).toContain('未绑定')
    expect(rows.find((r) => r.recipientMemberId === fei.id).status).toBe('skipped')
    expect(rows.find((r) => r.recipientMemberId === fei.id).error).toContain('飞书')
    const wkRow = rows.find((r) => r.recipientMemberId === wk.id)
    expect(wkRow.status).toBe('skipped')
    expect(wkRow.error).toContain('企微') // K6：企微连接器只读，推送通道仅飞书
    expect(wkRow.channelPlatform).toBe('wecom')
  })

  it('S46-4: web 通知收件箱——GET /api/v1/pushes 仅返回本人推送（类型/标题/正文/时刻/状态齐备）', async () => {
    const ctx = await setupApp()
    db = ctx.db
    await notifyMember(db, ctx.members.lead, { pushType: 'daily_report', title: '项目大脑日报', body: '张三的日报正文' })
    await notifyMember(db, ctx.members.dev, { pushType: 'alert', title: '逾期任务预警：李四', body: '李四的预警正文' })

    const leadCookie = await loginCookie(ctx.app, 'zhangsan', 'pass-123456')
    const res = await authed(ctx.app, leadCookie, 'GET', '/api/v1/pushes')
    expect(res.status).toBe(200)
    expect(res.body.pushes.length).toBe(1)
    const p = res.body.pushes[0]
    expect(p.title).toBe('项目大脑日报')
    expect(p.body).toContain('张三')
    expect(p.pushType).toBe('daily_report')
    expect(p.status).toBe('skipped') // 测试库无飞书配置 → skipped，收件箱仍可读
    expect(typeof p.createdAt).toBe('number')

    const devCookie = await loginCookie(ctx.app, 'lisi', 'pass-123456')
    const res2 = await authed(ctx.app, devCookie, 'GET', '/api/v1/pushes')
    expect(res2.body.pushes.length).toBe(1)
    expect(res2.body.pushes[0].title).toContain('李四')
    ctx.db.close()
  })

  it('S46-5: 日报/预警/建议通知全部经过同一投递层（三态语义一致，不再只写库不发送）', async () => {
    ;({ db } = setupDb())
    const members = seedMembers(db)
    const calls = []
    const fakeSend = async (msg) => { calls.push(msg); return { messageId: `om_${calls.length}` } }

    // 日报：飞书成员真实投递，企微/无身份成员 skipped
    await dailyReport(db, { force: true, send: fakeSend })
    let rows = db.prepare(`SELECT * FROM pushes WHERE push_type = 'daily_report'`).all()
    expect(rows.find((r) => r.recipient_member_id === members.lead.id).status).toBe('sent')
    expect(rows.find((r) => r.recipient_member_id === members.dev.id).status).toBe('sent')
    expect(rows.find((r) => r.recipient_member_id === members.key.id).status).toBe('skipped') // 企微
    expect(rows.find((r) => r.recipient_member_id === members.admin.id).status).toBe('skipped') // 无 IM 身份
    const reportCalls = calls.length
    expect(reportCalls).toBe(2) // 仅两名飞书成员真实投递

    // 预警：关键人逾期任务 → 推本人（企微→skipped）+ 管理员（无身份→skipped），同一投递层落行
    const p = createProject(db, { name: '客户H系统', typeCode: 'lianmai_365', leadMemberId: members.key.id }, members.admin.id)
    db.prepare('UPDATE tasks SET responsible_member_id = ?, plan_end_date = ? WHERE id = ?')
      .run(members.key.id, addDays(today(), -1), p.tasks[0].id)
    const { alerts } = await evaluateAlerts(db, { send: fakeSend })
    expect(alerts.find((a) => a.type === 'overdue_tasks' && a.memberId === members.key.id)).toBeTruthy()
    const alertRows = db.prepare(`SELECT * FROM pushes WHERE push_type = 'alert'`).all()
    expect(alertRows.length).toBeGreaterThanOrEqual(2) // 本人 + 管理员
    expect(alertRows.every((r) => ['sent', 'failed', 'skipped'].includes(r.status))).toBe(true)

    // 建议通知（S3-4 pushSuggestion）：目标任务责任人 + 牵头人，经同一投递层
    const evt = addEvent(db, {
      projectId: p.id, businessTime: Date.now(), nature: 'suggestion', eventType: 'status_change',
      summary: '任务状态变更建议', targetTaskId: p.tasks[0].id, targetField: 'status', targetValue: 'done', generatedBy: 'extraction',
    })
    expect(evt.status).toBe('pending')
    await pushSuggestion(db, evt, { send: fakeSend })
    const sugRows = db.prepare(`SELECT * FROM pushes WHERE related_project_id = ? AND push_type = 'digest'`).all(p.id)
    expect(sugRows.length).toBeGreaterThanOrEqual(1) // 责任人是企微成员 → skipped 落行
    expect(sugRows.every((r) => ['sent', 'skipped'].includes(r.status))).toBe(true)
  })
})
