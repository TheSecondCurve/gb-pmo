import { describe, it, expect, afterAll } from 'vitest'
import { setupApp, loginCookie, authed } from './helpers.mjs'
import { dailyReport } from '../brain/report.js'
import { evaluateAlerts } from '../brain/alert.js'
import { queryMetric } from '../engine/metrics.js'
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

    const { alerts } = evaluateAlerts(ctx.db)
    const ovd = alerts.find((a) => a.type === 'overdue_tasks' && a.memberId === ctx.members.key.id)
    expect(ovd).toBeTruthy()
    expect(ovd.projects).toContain(p.id)
    const toKey = ctx.db.prepare(`SELECT * FROM pushes WHERE push_type = 'alert' AND recipient_member_id = ? AND title LIKE '%逾期任务预警%'`).get(ctx.members.key.id)
    const toBoss = ctx.db.prepare(`SELECT * FROM pushes WHERE push_type = 'alert' AND recipient_member_id = ? AND title LIKE '%逾期任务预警%'`).get(ctx.members.admin.id)
    expect(toKey.body).toContain('客户H系统')
    expect(toKey.body).toContain(task.title)
    expect(toBoss).toBeTruthy()
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

    const { alerts } = evaluateAlerts(ctx.db)
    expect(alerts.some((a) => a.type === 'overloaded' && a.member === '王五')).toBe(true)
    const alert = ctx.db.prepare(`SELECT * FROM pushes WHERE push_type = 'alert' AND title LIKE '%负载预警：王五%'`).get()
    expect(alert).toBeTruthy()
  })
})
