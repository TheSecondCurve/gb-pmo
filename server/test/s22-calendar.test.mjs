import { describe, it, expect, afterAll } from 'vitest'
import { setupApp, loginCookie, authed } from './helpers.mjs'
import { today } from '../db/time.js'
import { setSetting, getSetting } from '../engine/settings.js'
import { closeProject } from '../engine/projects.js'
import { TASKS, dueTasks } from '../brain/scheduler.js'
import { syncProjectCalendar } from '../brain/calendar.js'

// PRD S22 — 飞书项目日历（v0.12）：组织级日历 + 对账式同步（hash 增量、结项保留、失败隔离）。
// 飞书 HTTP 层用 globalThis.fetch 注桩（同 S18 手法），数据库为真临时库。

let ctx
afterAll(() => { ctx?.db.close(); globalThis.fetch = undefined })

const dayOff = (n) => new Date(Date.parse(`${today()}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
const T = (d) => d.getTime()
const at = (y, mo, d, h, mi) => T(new Date(y, mo, d, h, mi))

async function admin() {
  return loginCookie(ctx.app, 'admin', 'admin-pass-123')
}

async function mkProject(name, extra = {}) {
  const res = await authed(ctx.app, await admin(), 'POST', '/api/v1/projects', {
    name, templateCode: 'custom', leadMemberId: ctx.members.lead.id, ...extra,
  })
  if (res.status !== 201) throw new Error(`mkProject failed: ${res.status} ${JSON.stringify(res.body)}`)
  return res.body
}

function configureCalendar(db, { calendarId = 'cal_9' } = {}) {
  setSetting(db, 'im.feishu', { appId: 'cli_x', appSecret: 'sec' }, 1)
  setSetting(db, 'calendar', { feishuCalendarId: calendarId }, 1)
}

/** 注桩飞书：记录全部调用；events 创建/更新按 respondEvent 分流（返回 { code, msg, event }）。 */
function stubFeishu(respondEvent) {
  const real = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url)
    const method = opts.method || 'GET'
    const body = opts.body ? JSON.parse(opts.body) : null
    calls.push({ u, method, body })
    if (u.includes('tenant_access_token')) return { ok: true, json: async () => ({ code: 0, tenant_access_token: 'tk' }) }
    if (u.includes('/calendar/v4/calendars') && u.includes('/events')) return { ok: true, json: async () => respondEvent({ u, method, body }) }
    if (u.includes('/calendar/v4/calendars')) return { ok: true, json: async () => ({ code: 0, data: { calendar: { calendar_id: 'cal_1' } } }) }
    return { ok: true, json: async () => ({ code: 0, data: {} }) }
  }
  return {
    calls,
    restore: () => { globalThis.fetch = real },
  }
}

describe('S22 飞书项目日历', () => {
  it('S22-1: 初始化——创建组织内可订阅日历并保存 calendar_id；未配置 appId 给指引；成员 403；留审计', async () => {
    ctx = await setupApp()
    const cookie = await admin()
    const memberCookie = await loginCookie(ctx.app, 'zhangsan', 'pass-123456')

    const noCfg = await authed(ctx.app, cookie, 'POST', '/api/v1/admin/calendar/init', {})
    expect(noCfg.status).toBe(400)
    expect(noCfg.body.message).toMatch(/appId/)

    const denied = await authed(ctx.app, memberCookie, 'POST', '/api/v1/admin/calendar/init', {})
    expect(denied.status).toBe(403)

    setSetting(ctx.db, 'im.feishu', { appId: 'cli_x', appSecret: 'sec' }, 1)
    const stub = stubFeishu(() => ({ code: 0, data: { event: {} } }))
    try {
      const ok = await authed(ctx.app, cookie, 'POST', '/api/v1/admin/calendar/init', {})
      expect(ok.status).toBe(200)
      expect(ok.body.calendarId).toBe('cal_1')
      const create = stub.calls.find((c) => c.method === 'POST' && c.u.includes('/calendar/v4/calendars') && !c.u.includes('/events'))
      expect(create).toBeTruthy()
      expect(create.body.summary).toMatch(/项目日历/)
      expect(create.body.permissions.share_tenant_permission).toBe('true') // 组织内可搜索订阅
      const saved = JSON.parse(ctx.db.prepare(`SELECT value FROM settings WHERE key = 'calendar'`).get().value)
      expect(saved.feishuCalendarId).toBe('cal_1')
      expect(ctx.db.prepare(`SELECT * FROM audit_logs WHERE action = 'calendar.init'`).get()).toBeTruthy()
    } finally {
      stub.restore()
    }
  })

  it('S22-2: 首轮建全日事件（闭区间）；内容未变零 API 调用；改交付日期走 patch；成员 403；留审计', async () => {
    ctx = await setupApp()
    const cookie = await admin()
    const memberCookie = await loginCookie(ctx.app, 'zhangsan', 'pass-123456')
    configureCalendar(ctx.db)
    const start = dayOff(-2)
    const p = await mkProject('日历项目A', { planStartDate: start, planEndDate: dayOff(20), priority: 'high' })
    await authed(ctx.app, cookie, 'PATCH', `/api/v1/projects/${p.id}`, { status: 'active' })
    await mkProject('无日期项目B') // 无任何起止 → 跳过计数

    let seq = 0
    const stub = stubFeishu(({ body }) => {
      seq += 1
      return { code: 0, data: { event: { event_id: `om_${seq}` } } }
    })
    try {
      const r1 = await authed(ctx.app, cookie, 'POST', '/api/v1/admin/calendar/sync', {})
      expect(r1.status).toBe(200)
      expect(r1.body).toMatchObject({ calendarId: 'cal_9', created: 1, updated: 0, skipped: 1, errors: [] })

      const create = stub.calls.find((c) => c.method === 'POST' && c.u.includes('/events'))
      expect(create.body.summary).toBe('日历项目A')
      expect(create.body.start_time.date).toBe(today()) // 已激活：起=实际启动日（‖计划开始日取先实后计）
      expect(create.body.end_time.date).toBe(dayOff(20)) // 闭区间：止=交付日当天
      expect(create.body.description).toMatch(/高/)

      const map = ctx.db.prepare('SELECT * FROM calendar_sync WHERE project_id = ?').get(p.id)
      expect(map.calendar_event_id).toBe('om_1')
      expect(map.content_hash).toBeTruthy()

      // 再同步：内容未变 → 不产生任何飞书调用（连 token 都不取）
      const before = stub.calls.length
      const r2 = await authed(ctx.app, cookie, 'POST', '/api/v1/admin/calendar/sync', {})
      expect(r2.body).toMatchObject({ created: 0, updated: 0, skipped: 1 })
      expect(stub.calls.length).toBe(before)

      // 改交付日期 → 内容 hash 变化 → patch 到同一 event_id
      await authed(ctx.app, cookie, 'PATCH', `/api/v1/projects/${p.id}`, { planEndDate: dayOff(25) })
      const r3 = await authed(ctx.app, cookie, 'POST', '/api/v1/admin/calendar/sync', {})
      expect(r3.body).toMatchObject({ created: 0, updated: 1 })
      const patch = stub.calls.filter((c) => c.method === 'PATCH').pop()
      expect(patch.u).toContain('/events/om_1')
      expect(patch.body.end_time.date).toBe(dayOff(25))

      expect(ctx.db.prepare(`SELECT * FROM audit_logs WHERE action = 'calendar.sync'`).get()).toBeTruthy()
      const denied = await authed(ctx.app, memberCookie, 'POST', '/api/v1/admin/calendar/sync', {})
      expect(denied.status).toBe(403)
    } finally {
      stub.restore()
    }
  })

  it('S22-3: 结项/取消项目事件保留——终态前缀 + 实际周期定格，不删除', async () => {
    ctx = await setupApp()
    const cookie = await admin()
    configureCalendar(ctx.db)
    const closed = await mkProject('已结项保留', { planStartDate: '2026-01-10', planEndDate: dayOff(10) })
    await authed(ctx.app, cookie, 'PATCH', `/api/v1/projects/${closed.id}`, { status: 'active' })
    closeProject(ctx.db, closed.id, { summary: '交付完成' }, 1) // custom 模板零任务，可直接结项
    // 定格为实际周期（绕过激活时刻，直接布置实际起止）
    ctx.db.prepare('UPDATE projects SET actual_start_date = ?, actual_end_date = ? WHERE id = ?')
      .run('2026-01-10', '2026-03-15', closed.id)

    const cancelled = await mkProject('已取消保留', { planStartDate: '2026-02-01', planEndDate: dayOff(30) })
    await authed(ctx.app, cookie, 'PATCH', `/api/v1/projects/${cancelled.id}`, { status: 'cancelled' })
    // 取消无实际结束日 → 止=交付日期（plan_end_date）
    ctx.db.prepare('UPDATE projects SET actual_start_date = ? WHERE id = ?').run('2026-02-01', cancelled.id)

    let seq = 0
    const stub = stubFeishu(() => {
      seq += 1
      return { code: 0, data: { event: { event_id: `om_${seq}` } } }
    })
    try {
      const r = await authed(ctx.app, cookie, 'POST', '/api/v1/admin/calendar/sync', {})
      expect(r.body).toMatchObject({ created: 2, errors: [] })
      const evClosed = stub.calls.find((c) => c.body?.summary === '【已结项】已结项保留')
      expect(evClosed.body.start_time.date).toBe('2026-01-10')
      expect(evClosed.body.end_time.date).toBe('2026-03-15')
      const evCancelled = stub.calls.find((c) => c.body?.summary === '【已取消】已取消保留')
      expect(evCancelled.body.start_time.date).toBe('2026-02-01')
      expect(evCancelled.body.end_time.date).toBe(dayOff(30))

      // 再同步两次（模拟后续轮次）：终态项目零 API 调用、绝不 DELETE
      const before = stub.calls.length
      await authed(ctx.app, cookie, 'POST', '/api/v1/admin/calendar/sync', {})
      expect(stub.calls.length).toBe(before)
      expect(stub.calls.some((c) => c.method === 'DELETE')).toBe(false)
    } finally {
      stub.restore()
    }
  })

  it('S22-4: 无日期项目跳过计数；单项目失败不阻塞其余并回显错误；下轮自动重试补齐', async () => {
    ctx = await setupApp()
    const cookie = await admin()
    configureCalendar(ctx.db)
    const ok1 = await mkProject('成功项目', { planStartDate: dayOff(-1), planEndDate: dayOff(15) })
    const bad = await mkProject('失败项目', { planStartDate: dayOff(-1), planEndDate: dayOff(15) })
    await mkProject('无日期项目')

    let failFirst = true
    let seq = 0
    const stub = stubFeishu(({ body }) => {
      if (failFirst && body?.summary === '失败项目') return { code: 19024, msg: '日程写入失败' }
      seq += 1
      return { code: 0, data: { event: { event_id: `om_${seq}` } } }
    })
    try {
      const r1 = await authed(ctx.app, cookie, 'POST', '/api/v1/admin/calendar/sync', {})
      expect(r1.body).toMatchObject({ created: 1, skipped: 1 })
      expect(r1.body.errors).toHaveLength(1)
      expect(r1.body.errors[0]).toMatchObject({ projectId: bad.id, name: '失败项目' })
      expect(r1.body.errors[0].error).toMatch(/日程写入失败/)
      // 成功项目已建映射；失败项目无映射行（下轮整体重试 create）
      expect(ctx.db.prepare('SELECT * FROM calendar_sync WHERE project_id = ?').get(ok1.id)).toBeTruthy()
      expect(ctx.db.prepare('SELECT * FROM calendar_sync WHERE project_id = ?').get(bad.id)).toBeUndefined()

      failFirst = false
      const r2 = await authed(ctx.app, cookie, 'POST', '/api/v1/admin/calendar/sync', {})
      expect(r2.body).toMatchObject({ created: 1, updated: 0, errors: [] })
      expect(ctx.db.prepare('SELECT * FROM calendar_sync WHERE project_id = ?').get(bad.id)).toBeTruthy()
    } finally {
      stub.restore()
    }
  })

  it('S22-6: 上游失败——502 信息携带飞书业务码；服务端落 error 级日志不静默；不误存 calendar_id', async () => {
    const errs = []
    const sink = {
      level: 'info',
      info() {}, debug() {}, warn() {}, trace() {}, fatal() {},
      error: (e) => errs.push(e),
      child() { return sink },
    }
    ctx = await setupApp({ loggerInstance: sink })
    const cookie = await admin()
    setSetting(ctx.db, 'im.feishu', { appId: 'cli_x', appSecret: 'sec' }, 1)

    // 日历创建被飞书拒（业务码 99991679 = 权限类），token 正常——复现「测试连接通、初始化 502」
    const real = globalThis.fetch
    globalThis.fetch = async (url) => {
      const u = String(url)
      if (u.includes('tenant_access_token')) return { ok: true, json: async () => ({ code: 0, tenant_access_token: 'tk' }) }
      if (u.includes('/calendar/v4/calendars')) return { ok: true, json: async () => ({ code: 99991679, msg: 'You have no permission to access calendar' }) }
      return { ok: true, json: async () => ({ code: 0, data: {} }) }
    }
    try {
      const r = await authed(ctx.app, cookie, 'POST', '/api/v1/admin/calendar/init', {})
      expect(r.status).toBe(502)
      expect(r.body.message).toMatch(/99991679/)
      expect(r.body.message).toMatch(/no permission/)
      expect(errs.length).toBeGreaterThan(0) // 不静默：5xx 必落 error 日志
      expect(errs.some((e) => String(e?.message || e).includes('99991679'))).toBe(true)
      expect(getSetting(ctx.db, 'calendar').feishuCalendarId).toBe('') // 失败不误存
    } finally {
      globalThis.fetch = real
    }
  })

  it('S22-5: 调度注册（calendarSyncCron/enabled 热生效）；未初始化日历静默跳过', async () => {
    const t = TASKS.find((x) => x.key === 'calendarSync')
    expect(t).toEqual({ key: 'calendarSync', cronKey: 'calendarSyncCron', enabledKey: 'calendarSyncEnabled' })

    const cfg = { calendarSyncCron: '*/30 * * * *', calendarSyncEnabled: true }
    expect(dueTasks(cfg, { calendarSync: at(2026, 8, 30, 10, 0) }, at(2026, 8, 30, 10, 31))).toContain('calendarSync')
    expect(dueTasks(cfg, { calendarSync: at(2026, 8, 30, 10, 0) }, at(2026, 8, 30, 10, 29))).toEqual([])
    expect(dueTasks({ ...cfg, calendarSyncEnabled: false }, { calendarSync: at(2026, 8, 30, 10, 0) }, at(2026, 8, 30, 10, 31))).toEqual([])

    ctx = await setupApp()
    const out = await syncProjectCalendar(ctx.db) // 未初始化（settings 默认空 calendar_id）
    expect(out.skipped).toBe(true)
    expect(out.reason).toMatch(/未初始化/)
  })
})
