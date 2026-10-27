import { describe, it, expect, afterAll } from 'vitest'
import { setupApp, loginCookie, authed, waitFor } from './helpers.mjs'
import { TASKS, dueTasks, initialLastRun, startScheduler } from '../brain/scheduler.js'
import { getSetting, setSetting } from '../engine/settings.js'
import { bjDayStartMs } from '../db/time.js'

// PRD S67（v0.75，K53）— 配置台「定时任务」集中管理页：
// 全部 7 项调度任务一页配 cron + 启用开关（含 S68 新增晨报任务）；纯提醒发送门槛
// reminder.fireAfterHour 收口到同页（补 0-23 校验器，此前只能走 API 改）。
// v0.77（K58）：S67-5 手动触发（POST /api/v1/admin/scheduler/run）；晨报锚点改进程启动时刻（重启不补跑）。

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

  it('S67-4: 心跳即时遵从开关——停用不触发，启用瞬间不回溯补跑，越过下一匹配分钟即触发', async () => {
    ctx = await setupApp()
    const { db } = ctx
    let now = Date.now()
    let runs = 0
    setSetting(db, 'scheduler', { morningCron: '* * * * *', morningEnabled: false }, 1)
    const sched = startScheduler(db, {
      llm: null,
      tickMs: 5,
      now: () => now,
      runners: { morning: async () => { runs += 1 } },
    })
    try {
      await new Promise((r) => setTimeout(r, 20))
      expect(runs).toBe(0) // 停用后不触发
      setSetting(db, 'scheduler', { morningCron: '* * * * *', morningEnabled: true }, 1) // setSetting 整块替换，cron 需随行带上
      await new Promise((r) => setTimeout(r, 20))
      expect(runs).toBe(0) // v0.77 锚点=启动时刻：启用瞬间不回溯补跑（旧锚点「今日00:00」会立即命中）
      now += 61_000
      await waitFor(() => runs === 1) // 越过下一个 cron 匹配分钟即触发（S18-5 重新启用按 cron 补判定语义保留）
      expect(runs).toBe(1)
    } finally {
      sched.stop()
    }
  })

  it('S67-2/S68-4: dueTasks 按 morningCron 判定（(lastRun, now] 窗口语义）', () => {
    const cfg = { morningCron: '30 9 * * *', morningEnabled: true }
    // 2026-10-01 09:30 落入窗口（昨日 09:30 → 今日 09:30]；同分钟后窗口已无命中
    expect(dueTasks(cfg, { morning: at(2026, 9, 30, 9, 30) }, at(2026, 10, 1, 9, 30))).toEqual(['morning'])
    expect(dueTasks(cfg, { morning: at(2026, 10, 1, 9, 30) }, at(2026, 10, 1, 9, 31))).toEqual([])
    expect(dueTasks({ ...cfg, morningEnabled: false }, { morning: at(2026, 9, 30, 9, 30) }, at(2026, 10, 1, 9, 30))).toEqual([])
  })

  it('S68-4: initialLastRun 锚定进程启动时刻（v0.77 重启不补跑）；digest 仍锚今日 00:00（周级补跑）', async () => {
    ctx = await setupApp()
    const now = Date.now()
    expect(initialLastRun(ctx.db, 'morning', now)).toBe(now)
    expect(initialLastRun(ctx.db, 'digest', now)).toBe(bjDayStartMs(now))
  })

  it('S67-5: 手动触发——管理员 POST scheduler/run 走注入 runner 回显结果并审计；成员 403、未知任务 400、失败折返 200', async () => {
    const calls = []
    ctx = await setupApp({
      schedulerRunners: {
        morning: async (dbArg) => {
          calls.push(dbArg)
          return { at: '2026-10-27', results: [{ projectId: 1, pushed: true }, { projectId: 2, skipped: true, reason: '今日已推送' }] }
        },
        backup: async () => { throw Object.assign(new Error('备份上传失败'), { statusCode: 502 }) },
      },
    })
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const leadCookie = await loginCookie(ctx.app, 'zhangsan', 'pass-123456')

    const member = await authed(ctx.app, leadCookie, 'POST', '/api/v1/admin/scheduler/run', { task: 'morning' })
    expect(member.status).toBe(403)

    const bad = await authed(ctx.app, cookie, 'POST', '/api/v1/admin/scheduler/run', { task: 'nope' })
    expect(bad.status).toBe(400)

    const ok = await authed(ctx.app, cookie, 'POST', '/api/v1/admin/scheduler/run', { task: 'morning' })
    expect(ok.status).toBe(200)
    expect(ok.body.ok).toBe(true)
    expect(ok.body.task).toBe('morning')
    expect(ok.body.result.results).toHaveLength(2)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toBe(ctx.db) // 同一 db 实例（与调度器同一执行体）

    const fail = await authed(ctx.app, cookie, 'POST', '/api/v1/admin/scheduler/run', { task: 'backup' })
    expect(fail.status).toBe(200) // v0.21 网关模式：上游失败 200 + ok:false
    expect(fail.body.ok).toBe(false)
    expect(fail.body.error).toMatch(/上传失败/)

    const audits = ctx.db.prepare(`SELECT detail FROM audit_logs WHERE action = 'scheduler.run' ORDER BY id`).all()
    expect(JSON.parse(audits[0].detail)).toEqual({ task: 'morning', ok: true })
    expect(JSON.parse(audits[1].detail)).toEqual({ task: 'backup', ok: false, error: '备份上传失败' })
  })

  it('S67-6: cron 运行落台账——成功摘要聚合计数、失败记错误且不阻塞同拍其余任务', async () => {
    ctx = await setupApp()
    const { db } = ctx
    let now = Date.now()
    setSetting(db, 'scheduler', {
      morningCron: '* * * * *', morningEnabled: true,
      backupCron: '* * * * *', backupEnabled: true,
      extractionCron: '0 3 1 1 *', alertCron: '0 3 1 1 *', reportCron: '0 3 1 1 *',
      calendarSyncCron: '0 3 1 1 *', digestCron: '0 3 1 1 *', // 其余任务不进本拍，保持确定性
    }, 1)
    const sched = startScheduler(db, {
      llm: null,
      tickMs: 5,
      now: () => now,
      runners: {
        morning: async () => ({ at: '2026-10-27', results: [{ projectId: 1, pushed: true }, { projectId: 2, skipped: true, reason: '今日已推送' }] }),
        backup: async () => { throw Object.assign(new Error('上传失败'), { statusCode: 502 }) },
      },
    })
    try {
      now += 61_000
      await waitFor(() => db.prepare(`SELECT COUNT(*) AS n FROM scheduler_runs WHERE task IN ('morning','backup')`).get().n === 2)
    } finally {
      sched.stop()
    }
    const morning = db.prepare(`SELECT * FROM scheduler_runs WHERE task = 'morning'`).get()
    expect(morning.origin).toBe('cron')
    expect(morning.ok).toBe(1)
    expect(JSON.parse(morning.summary)).toEqual({ total: 2, pushed: 1, skipped: 1, failed: 0 })
    const backup = db.prepare(`SELECT * FROM scheduler_runs WHERE task = 'backup'`).get()
    expect(backup.ok).toBe(0)
    expect(JSON.parse(backup.summary).error).toBe('上传失败')
    expect(backup.duration_ms).toBeGreaterThanOrEqual(0)
  })

  it('S67-6: 手动触发落台账（origin=manual+操作人）；GET scheduler/runs 最近记录新→旧可读、成员 403', async () => {
    ctx = await setupApp({
      schedulerRunners: {
        morning: async () => ({ at: '2026-10-27', results: [{ projectId: 1, pushed: true }] }),
      },
    })
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const leadCookie = await loginCookie(ctx.app, 'zhangsan', 'pass-123456')
    const run = await authed(ctx.app, cookie, 'POST', '/api/v1/admin/scheduler/run', { task: 'morning' })
    expect(run.body.ok).toBe(true)

    const member = await authed(ctx.app, leadCookie, 'GET', '/api/v1/admin/scheduler/runs')
    expect(member.status).toBe(403)

    const r = await authed(ctx.app, cookie, 'GET', '/api/v1/admin/scheduler/runs')
    expect(r.status).toBe(200)
    const row = r.body.runs[0]
    expect(row).toMatchObject({ task: 'morning', origin: 'manual', ok: 1 })
    expect(row.memberName).toBeTruthy() // 手动触发带操作人（cron 行为 null）
    expect(row.startedAt).toBeTypeOf('number')
    expect(JSON.parse(row.summary)).toEqual({ total: 1, pushed: 1, skipped: 0, failed: 0 })
  })
})
