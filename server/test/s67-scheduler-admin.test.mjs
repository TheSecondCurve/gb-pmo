import { describe, it, expect, afterAll } from 'vitest'
import { setupApp, loginCookie, authed, waitFor } from './helpers.mjs'
import { TASKS, dueTasks, initialLastRun, startScheduler } from '../brain/scheduler.js'
import { getSetting, setSetting } from '../engine/settings.js'
import { bjDayStartMs } from '../db/time.js'

// PRD S67（v0.75，K53）— 配置台「定时任务」集中管理页：
// 全部 7 项调度任务一页配 cron + 启用开关（含 S68 新增晨报任务）；纯提醒发送门槛
// reminder.fireAfterHour 收口到同页（补 0-23 校验器，此前只能走 API 改）。

let ctx
afterAll(() => ctx?.db.close())

const at = (y, mo, d, h, mi) => new Date(y, mo, d, h, mi).getTime()

describe('S67 定时任务集中配置', () => {
  it('S67-1: settings.scheduler 含全部 7 项任务键（含新增晨报），默认值就位', async () => {
    ctx = await setupApp()
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const s = await authed(ctx.app, cookie, 'GET', '/api/v1/admin/settings')
    expect(s.body.scheduler).toEqual({
      extractionCron: '0 * * * *', alertCron: '*/15 * * * *', reportCron: '0 18 * * *',
      extractionEnabled: true, alertEnabled: true, reportEnabled: true,
      calendarSyncCron: '*/30 * * * *', calendarSyncEnabled: true,
      backupCron: '30 3 * * *', backupEnabled: true,
      digestCron: '0 9 * * 1', digestEnabled: true,
      morningCron: '30 9 * * *', morningEnabled: true, // v0.75 新增（S68 每日项目群晨报）
    })
    // 任务表 7 项，晨报在内
    expect(TASKS.map((t) => t.key)).toEqual(['extraction', 'alerts', 'report', 'calendarSync', 'backup', 'digest', 'morning'])
  })

  it('S67-2: 非法 cron / 非布尔开关拒绝（400 带字段），合法保存回读一致；成员 403', async () => {
    ctx = await setupApp()
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const leadCookie = await loginCookie(ctx.app, 'zhangsan', 'pass-123456')

    const badCron = await authed(ctx.app, cookie, 'PUT', '/api/v1/admin/settings/scheduler', {
      morningCron: '99 * * * *',
    })
    expect(badCron.status).toBe(400)
    expect(JSON.stringify(badCron.body)).toMatch(/分/)

    const badToggle = await authed(ctx.app, cookie, 'PUT', '/api/v1/admin/settings/scheduler', {
      morningEnabled: 'yes',
    })
    expect(badToggle.status).toBe(400)
    expect(JSON.stringify(badToggle.body)).toMatch(/morningEnabled/)

    const memberPut = await authed(ctx.app, leadCookie, 'PUT', '/api/v1/admin/settings/scheduler', {
      morningCron: '30 8 * * *',
    })
    expect(memberPut.status).toBe(403)

    const ok = await authed(ctx.app, cookie, 'PUT', '/api/v1/admin/settings/scheduler', {
      morningCron: '30 8 * * *',
    })
    expect(ok.status).toBe(200)
    const after = await authed(ctx.app, cookie, 'GET', '/api/v1/admin/settings')
    expect(after.body.scheduler.morningCron).toBe('30 8 * * *')
    expect(after.body.scheduler.morningEnabled).toBe(true) // 未覆盖项保持默认
    expect(after.body.scheduler.reportCron).toBe('0 18 * * *')
  })

  it('S67-3: reminder.fireAfterHour 收口——合法保存回读、越界/非整数 400、成员 403', async () => {
    ctx = await setupApp()
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const leadCookie = await loginCookie(ctx.app, 'zhangsan', 'pass-123456')

    expect(getSetting(ctx.db, 'reminder').fireAfterHour).toBe(9) // 默认门槛

    const memberPut = await authed(ctx.app, leadCookie, 'PUT', '/api/v1/admin/settings/reminder', { fireAfterHour: 8 })
    expect(memberPut.status).toBe(403)

    const badHour = await authed(ctx.app, cookie, 'PUT', '/api/v1/admin/settings/reminder', { fireAfterHour: 24 })
    expect(badHour.status).toBe(400)
    const badType = await authed(ctx.app, cookie, 'PUT', '/api/v1/admin/settings/reminder', { fireAfterHour: '9' })
    expect(badType.status).toBe(400)

    const ok = await authed(ctx.app, cookie, 'PUT', '/api/v1/admin/settings/reminder', { fireAfterHour: 8 })
    expect(ok.status).toBe(200)
    expect(ok.body.value.fireAfterHour).toBe(8)
    expect(getSetting(ctx.db, 'reminder').fireAfterHour).toBe(8)
  })

  it('S67-4: 心跳即时遵从开关——停用的晨报任务不触发，启用后按 cron 补判定', async () => {
    ctx = await setupApp()
    const { db } = ctx
    const NOW = Date.now()
    let runs = 0
    setSetting(db, 'scheduler', { morningCron: '* * * * *', morningEnabled: false }, 1)
    const sched = startScheduler(db, {
      llm: null,
      tickMs: 5,
      now: () => NOW,
      runners: { morning: async () => { runs += 1 } },
    })
    try {
      await new Promise((r) => setTimeout(r, 20))
      expect(runs).toBe(0) // 停用后冷启动窗口命中也不触发
      setSetting(db, 'scheduler', { morningEnabled: true }, 1)
      await waitFor(() => runs === 1) // 重新启用 → 窗口（今日00:00→now）命中补跑一次
      expect(runs).toBe(1)
    } finally {
      sched.stop()
    }
  })

  it('S67-2/S68-4: dueTasks 按 morningCron 判定；锚点 initialLastRun=今日 00:00', () => {
    const cfg = { morningCron: '30 9 * * *', morningEnabled: true }
    // 2026-10-01 09:30 落入窗口（昨日 09:30 → 今日 09:30]；同分钟后窗口已无命中
    expect(dueTasks(cfg, { morning: at(2026, 9, 30, 9, 30) }, at(2026, 10, 1, 9, 30))).toEqual(['morning'])
    expect(dueTasks(cfg, { morning: at(2026, 10, 1, 9, 30) }, at(2026, 10, 1, 9, 31))).toEqual([])
    expect(dueTasks({ ...cfg, morningEnabled: false }, { morning: at(2026, 9, 30, 9, 30) }, at(2026, 10, 1, 9, 30))).toEqual([])
  })

  it('S68-4: initialLastRun 锚定今日 00:00（停机当日补跑，项目级日幂等兜底）', async () => {
    ctx = await setupApp()
    const now = Date.now()
    expect(initialLastRun(ctx.db, 'morning', now)).toBe(bjDayStartMs(now))
  })
})
