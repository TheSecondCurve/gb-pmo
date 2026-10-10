import { describe, it, expect, afterAll } from 'vitest'
import { setupApp, loginCookie, authed } from './helpers.mjs'
import { dailyReport } from '../brain/report.js'
import { evaluateAlerts } from '../brain/alert.js'
import { queryMetric } from '../engine/metrics.js'
import { buildOverdueAlertCard, buildLoadAlertCard, buildSilentAlertCard } from '../brain/bot/cards.js'
import { today, addDays } from '../db/time.js'

// PRD S6 / S7 — 日报分视角与「今日无更新」；关键人逾期任务与过载预警（v0.6：S7-1 改逾期任务口径）

let ctx
afterAll(() => ctx?.db.close())

async function mkProject(name, leadId, priority = 'medium') {
  const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
  // 交付日期 today() 同源 +30 天，避免时间炸弹与 UTC 偏差；S29 起立项即进行中，无需再切状态
  const planEndDate = new Date(Date.parse(`${today()}T00:00:00Z`) + 30 * 86400000).toISOString().slice(0, 10)
  const res = await authed(ctx.app, cookie, 'POST', '/api/v1/projects', {
    name, templateCode: 'lianmai_365', leadMemberId: leadId, priority, planEndDate,
  })
  return res.body
}

describe('S6 日报', () => {
  it('S6-1/S6-2: 按角色分视角生成并推送；无更新项目标注「今日无更新」而非省略', async () => {
    ctx = await setupApp()
    const quiet = await mkProject('安静的项目', ctx.members.dev.id) // 今日无任何事件（立项等事件压到昨天）
    ctx.db.prepare('UPDATE project_events SET business_time = ? WHERE project_id = ?').run(Date.now() - 2 * 86400000, quiet.id)
    const busy = await mkProject('热闹的项目', ctx.members.lead.id)
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    await authed(ctx.app, cookie, 'POST', `/api/v1/projects/${busy.id}/events`, {
      eventType: 'progress', summary: '联调通过', nature: 'record',
    })

    const out = await dailyReport(ctx.db, { force: true })
    expect(out.reports).toBe(4) // 全部在职成员
    const pushes = ctx.db.prepare(`SELECT * FROM pushes WHERE push_type = 'daily_report'`).all()
    expect(pushes.length).toBe(4)
    const bossPush = pushes.find((p) => p.recipient_member_id === ctx.members.admin.id)
    expect(bossPush.body).toContain('安静的项目：今日无更新')
    expect(bossPush.body).toContain('热闹的项目')
    expect(bossPush.body).toMatch(/\d+ 条更新/)
    const leadPush = pushes.find((p) => p.recipient_member_id === ctx.members.lead.id)
    expect(leadPush.body).toContain('【所辖项目】')
    expect(leadPush.body).toContain('热闹的项目')
  })
})

describe('S7 预警', () => {
  it('S7-1: 关键人名下逾期未完任务 ≥1 → 推老板（管理员）与本人，列出任务与项目（v0.6 口径）', async () => {
    const p = await mkProject('客户H系统', ctx.members.key.id)
    const yesterday = addDays(today(), -1) // S19：北京昨日（裸 toISOString 在北京 00:00–08:00 是前天）
    // 王五（关键人）名下任务逾期：直接把模板任务责任人改给王五并设过期截止日
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const task = p.tasks[0]
    await authed(ctx.app, cookie, 'PATCH', `/api/v1/tasks/${task.id}`, { responsibleMemberId: ctx.members.key.id, planEndDate: yesterday })

    const { alerts } = await evaluateAlerts(ctx.db)
    const ovd = alerts.find((a) => a.type === 'overdue_tasks' && a.memberId === ctx.members.key.id)
    expect(ovd).toBeTruthy()
    expect(ovd.projects).toContain(p.id)
    const toKey = ctx.db.prepare(`SELECT * FROM pushes WHERE push_type = 'alert' AND recipient_member_id = ? AND title LIKE '%逾期任务预警%'`).get(ctx.members.key.id)
    const toBoss = ctx.db.prepare(`SELECT * FROM pushes WHERE push_type = 'alert' AND recipient_member_id = ? AND title LIKE '%逾期任务预警%'`).get(ctx.members.admin.id)
    expect(toKey.body).toContain('客户H系统')
    expect(toKey.body).toContain(task.title)
    expect(toBoss).toBeTruthy()
  })

  it('S7-1: 逾期预警以交互卡片送达——红色 header + 任务表格（任务/项目/截止/超期天数），管理员抄送同卡（v0.63）', async () => {
    // 王五的逾期任务由上一条用例留置（未完成未改期）；补飞书绑定后注入假发送器捕获载荷
    ctx.db.prepare('UPDATE members SET feishu_id = ? WHERE id = ?').run('fs_wang', ctx.members.key.id)
    ctx.db.prepare('UPDATE members SET feishu_id = ? WHERE id = ?').run('fs_admin', ctx.members.admin.id)
    const sent = []
    await evaluateAlerts(ctx.db, { send: async (m) => { sent.push(m); return { messageId: 'om_x' } } })

    const toKey = sent.find((m) => m.openId === 'fs_wang' && m.card)
    expect(toKey).toBeTruthy()
    expect(toKey.card.header.template).toBe('red')
    expect(toKey.card.header.title.content).toContain('逾期任务预警：王五')
    expect(toKey.card.header.title.content).toContain('1 项')
    const cardJson = JSON.stringify(toKey.card)
    expect(cardJson).toContain('客户H系统')
    expect(cardJson).toContain('超 1 天') // 截止昨天 → 超期 1 天（dayDiff 北京口径）
    expect(toKey.card.elements.some((el) => el.tag === 'column_set')).toBe(true) // ≤8 行成表
    // 管理员抄送同一卡片
    expect(sent.some((m) => m.openId === 'fs_admin' && m.card && m.card.header.title.content.includes('逾期任务预警：王五'))).toBe(true)
    // 兜底文本（降级 post/text 与 web 收件箱共用）带粗体排版标记
    const row = ctx.db.prepare(`SELECT body FROM pushes WHERE push_type = 'alert' AND recipient_member_id = ? AND title LIKE '%逾期任务预警%' ORDER BY id DESC`).get(ctx.members.key.id)
    expect(row.body).toContain('**客户H系统**')
  })

  it('S7-2: 关键人并行项目超过上限 → 老板视图标红并推送负载预警', async () => {
    // 王五 maxParallelProjects=2（seed），给 3 个进行中项目
    await mkProject('项目甲', ctx.members.key.id)
    await mkProject('项目乙', ctx.members.key.id)
    await mkProject('项目丙', ctx.members.key.id)
    const load = queryMetric(ctx.db, 'keyperson_load', { groupBy: 'member' })
    const wang = load.rows.find((r) => r.member === '王五')
    expect(wang.parallelProjects).toBeGreaterThanOrEqual(3)
    expect(wang.overloaded).toBe(true)

    const { alerts } = await evaluateAlerts(ctx.db)
    expect(alerts.some((a) => a.type === 'overloaded' && a.member === '王五')).toBe(true)
    const alert = ctx.db.prepare(`SELECT * FROM pushes WHERE push_type = 'alert' AND title LIKE '%负载预警：王五%'`).get()
    expect(alert).toBeTruthy()
  })

  it('S7-2: 负载预警推送同为卡片形态——橙色 header（v0.63）', async () => {
    // 王五过载由上一条用例留置；管理员飞书绑定已在 S7-1 卡片用例补上
    const sent = []
    await evaluateAlerts(ctx.db, { send: async (m) => { sent.push(m); return { messageId: 'om_y' } } })
    const load = sent.find((m) => m.openId === 'fs_admin' && m.card?.header?.title?.content?.includes('负载预警：王五'))
    expect(load).toBeTruthy()
    expect(load.card.header.template).toBe('orange')
    expect(JSON.stringify(load.card)).toContain('并行参与')
  })
})

describe('S7/S48 预警卡片模板（v0.63，K41）', () => {
  const taskRow = (i, extra = {}) => ({ id: i, title: `任务${i}`, projectName: '项目甲', planEndDate: '2026-10-01', daysOverdue: i, ...extra })

  it('S7-1: 逾期卡——≤8 行成表（任务/项目/截止/超期），参考链接成行；>8 退化文本行', () => {
    const card = buildOverdueAlertCard({
      memberName: '王五',
      tasks: [taskRow(1, { refs: [{ title: '验收 SOP', url: 'https://kb.example.com/sop' }] }), taskRow(2)],
    })
    expect(card.header.template).toBe('red')
    expect(card.header.title.content).toBe('逾期任务预警：王五（2 项）')
    expect(card.elements.filter((el) => el.tag === 'column_set').length).toBe(3) // 表头 + 2 数据行
    const s = JSON.stringify(card)
    expect(s).toContain('任务1')
    expect(s).toContain('https://kb.example.com/sop') // S23 参考资料保留

    const big = buildOverdueAlertCard({ memberName: '王五', tasks: Array.from({ length: 9 }, (_, i) => taskRow(i + 1)) })
    expect(big.header.title.content).toBe('逾期任务预警：王五（9 项）')
    expect(big.elements.some((el) => el.tag === 'column_set')).toBe(false) // 超 8 行退化文本行
    expect(JSON.stringify(big)).toContain('任务9')
  })

  it('S7-2: 负载卡——橙色 header，并行数/上限/未完任务在正文', () => {
    const card = buildLoadAlertCard({ member: '王五', parallelProjects: 4, maxParallelProjects: 2, openTasks: 7 })
    expect(card.header.template).toBe('orange')
    expect(card.header.title.content).toBe('负载预警：王五')
    const s = JSON.stringify(card)
    expect(s).toContain('4')
    expect(s).toContain('2')
    expect(s).toContain('7')
  })

  it('S48-4: 沉默卡——橙色 header 含项目名与沉默天数', () => {
    const card = buildSilentAlertCard({ projectName: '沉默的项目', days: 10 })
    expect(card.header.template).toBe('orange')
    expect(card.header.title.content).toBe('沉默项目预警：沉默的项目')
    const s = JSON.stringify(card)
    expect(s).toContain('沉默的项目')
    expect(s).toContain('10')
  })
})
