import { describe, it, expect, afterAll } from 'vitest'
import { setupApp, loginCookie, authed } from './helpers.mjs'
import { upsertChannel } from '../engine/tasks.js'
import { parseCron, isDue } from '../engine/cron.js'
import { dueTasks, initialLastRun, startScheduler } from '../brain/scheduler.js'
import { dailyReport } from '../brain/report.js'
import { setSetting } from '../engine/settings.js'

// PRD S18 — 大脑调度与手动对齐（cron 三件套 / 立即对齐 / 日报补发，v0.7）

let ctx
afterAll(() => { ctx?.db.close(); globalThis.fetch = undefined })

async function mkProject(name, leadId) {
  const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
  const res = await authed(ctx.app, cookie, 'POST', '/api/v1/projects', {
    name, templateCode: 'software_delivery', leadMemberId: leadId, planEndDate: '2026-12-31',
  })
  return res.body
}

const T = (d) => d.getTime()
const at = (y, mo, d, h, mi) => T(new Date(y, mo, d, h, mi))

describe('S18 cron 引擎（engine/cron.js）', () => {
  it('S18-3: 非法 cron 表达式被拒绝并指明字段', () => {
    const bad = [
      ['61 * * * *', '分'], ['* 25 * * *', '时'], ['* * 32 * *', '日'], ['* * * 13 *', '月'], ['* * * * 8', '周'],
      ['*/15 * * *', ''], ['*/0 * * * *', ''], ['a * * * *', ''], ['1-99 * * * *', '分'],
    ]
    for (const [expr] of bad) {
      let err = null
      try { parseCron(expr) } catch (e) { err = e }
      expect(err, `应拒绝: ${expr}`).toBeTruthy()
      expect(err.statusCode).toBe(400)
    }
    expect(() => parseCron('61 * * * *')).toThrowError(/分/)
    expect(() => parseCron('* 25 * * *')).toThrowError(/时/)
  })

  it('S18: 匹配语义——步进/整点/范围/列表/周一', () => {
    expect(isDue('*/15 * * * *', at(2026, 8, 30, 10, 59), at(2026, 8, 30, 11, 0))).toBe(true)
    expect(isDue('*/15 * * * *', at(2026, 8, 30, 10, 58), at(2026, 8, 30, 10, 59))).toBe(false)
    expect(isDue('0 18 * * *', at(2026, 8, 30, 17, 59), at(2026, 8, 30, 18, 0))).toBe(true)
    expect(isDue('0 18 * * *', at(2026, 8, 30, 18, 0), at(2026, 8, 30, 18, 1))).toBe(false)
    expect(isDue('0 18 * * *', at(2026, 8, 30, 18, 1), at(2026, 8, 30, 19, 0))).toBe(false)
    expect(isDue('30 9-18 * * *', at(2026, 8, 30, 8, 29), at(2026, 8, 30, 9, 30))).toBe(true)
    expect(isDue('30 9-18 * * *', at(2026, 8, 30, 19, 29), at(2026, 8, 30, 19, 30))).toBe(false)
    expect(isDue('0,30 * * * *', at(2026, 8, 30, 10, 0), at(2026, 8, 30, 10, 29))).toBe(false)
    expect(isDue('0,30 * * * *', at(2026, 8, 30, 10, 29), at(2026, 8, 30, 10, 30))).toBe(true)
    // 2026-09-28 是周一
    expect(isDue('0 0 * * 1', at(2026, 8, 27, 23, 59), at(2026, 8, 28, 0, 0))).toBe(true)
    expect(isDue('0 0 * * 1', at(2026, 8, 28, 23, 59), at(2026, 8, 29, 0, 0))).toBe(false)
  })
})

describe('S18 调度判定（scheduler）', () => {
  const crons = { extractionCron: '0 * * * *', alertCron: '*/15 * * * *', reportCron: '0 18 * * *' }

  it('S18-2: dueTasks 按配置判定应跑任务', () => {
    const now = at(2026, 8, 30, 11, 15)
    const dayStart = at(2026, 8, 30, 0, 0)
    // 窗口（今00:00 → 11:15）：extraction 含 00:00/11:00 命中；alerts 含 11:00/11:15 命中；report 18:00 未到
    expect(dueTasks(crons, { extraction: dayStart, alerts: at(2026, 8, 30, 11, 0), report: dayStart }, now))
      .toEqual(['extraction', 'alerts'])
    // report：今日 18:00 已过 → 补跑
    expect(dueTasks(crons, { extraction: at(2026, 8, 30, 18, 1), alerts: at(2026, 8, 30, 18, 1), report: dayStart }, at(2026, 8, 30, 18, 1)))
      .toEqual(['report'])
  })

  it('S18-2: 修改 cron 后判定随新配置变化（无需重启）', () => {
    const last = at(2026, 8, 30, 11, 5)
    const now = at(2026, 8, 30, 11, 12)
    expect(dueTasks(crons, { extraction: last, alerts: last, report: last }, now)).toEqual([])
    const tuned = { ...crons, extractionCron: '*/10 * * * *' } // 窗口含 11:10 命中
    expect(dueTasks(tuned, { extraction: last, alerts: last, report: last }, now)).toEqual(['extraction'])
  })

  it('S18-5: enabled=false 的任务不参与判定（默认视为启用）', () => {
    const yesterday = at(2026, 8, 29, 12, 0)
    const now = at(2026, 8, 30, 11, 15)
    const off = { ...crons, extractionEnabled: false, alertEnabled: false }
    expect(dueTasks(off, { extraction: yesterday, alerts: yesterday, report: yesterday }, now)).toEqual(['report'])
    // 显式 true / 缺省均视为启用
    expect(dueTasks({ ...crons, extractionEnabled: true }, { extraction: yesterday, alerts: now, report: now }, now)).toEqual(['extraction'])
  })

  it('S18-5: 心跳——停用开关的任务不触发', async () => {
    ctx = await setupApp()
    const { db } = ctx
    const base = new Date()
    base.setHours(18, 1, 0, 0)
    const NOW = T(base)
    const runs = { report: 0 }
    setSetting(db, 'scheduler', { reportEnabled: false }, 1)
    const sched = startScheduler(db, {
      llm: null,
      tickMs: 5,
      now: () => NOW,
      runners: { report: async () => { runs.report += 1 } },
    })
    try {
      await new Promise((r) => setTimeout(r, 20))
      expect(runs.report).toBe(0) // 停用后即使冷启动窗口命中也不触发
      setSetting(db, 'scheduler', { reportEnabled: true }, 1)
      await new Promise((r) => setTimeout(r, 20))
      expect(runs.report).toBe(1) // 重新启用 → 窗口（今日00:00→18:01）命中补跑一次
    } finally {
      sched.stop()
    }
  })

  it('S18-4: initialLastRun——日报停机补发锚点；其余任务锚定当前时刻', async () => {
    ctx = await setupApp()
    const now = new Date()
    now.setHours(19, 0, 0, 0)
    const dayStart = new Date(now).setHours(0, 0, 0, 0)
    // 当日未发日报：锚定今日 00:00 → 今日 18:00 落入窗口即补发
    expect(initialLastRun(ctx.db, 'report', T(now))).toBe(dayStart)
    expect(initialLastRun(ctx.db, 'extraction', T(now))).toBe(T(now))
    // 发出日报后：锚定最近一次日报推送时刻
    await dailyReport(ctx.db, { force: false })
    const lastPush = ctx.db
      .prepare(`SELECT MAX(created_at) AS t FROM pushes WHERE push_type = 'daily_report'`).get().t
    expect(initialLastRun(ctx.db, 'report', T(now))).toBe(lastPush)
  })

  it('S18-2/S18-4: 心跳按 cron 触发，改配置下一拍生效；report 冷启动补发', async () => {
    // 独立库（前置：当日无日报推送）。不能复用上一用例的 ctx——它的 dailyReport 会以真实时钟写
    // pushes 行，真实时间晚于本用例假时钟 18:01 时，initialLastRun 锚点会越过 now，补发窗口为空，
    // 测试就变成「每天只在 18:01 前跑得绿」的时间炸弹。
    ctx = await setupApp()
    const { db } = ctx
    const base = new Date()
    base.setHours(18, 1, 0, 0)
    let NOW = T(base)
    const runs = { extraction: 0, alerts: 0, report: 0 }
    const sched = startScheduler(db, {
      llm: null,
      tickMs: 5,
      now: () => NOW,
      runners: {
        extraction: async () => { runs.extraction += 1 },
        alerts: async () => { runs.alerts += 1 },
        report: async () => { runs.report += 1 },
      },
    })
    try {
      await new Promise((r) => setTimeout(r, 20))
      // 18:01 冷启动：extraction/alerts 锚定 now 不跑；report 锚定今日 00:00 → 18:00 已过 → 补发一次
      expect(runs).toEqual({ extraction: 0, alerts: 0, report: 1 })
      // 改 extractionCron 为每分钟 + 时钟走过一分钟 → 下一拍命中（S18-2 保存即生效）
      setSetting(db, 'scheduler', { extractionCron: '* * * * *' }, 1)
      NOW += 61_000
      await new Promise((r) => setTimeout(r, 20))
      expect(runs.extraction).toBeGreaterThanOrEqual(1)
      // report 已跑过（锚点推进）且 18:00 已在窗口外 → 不再重复触发
      expect(runs.report).toBe(1)
      expect(runs.alerts).toBe(0)
    } finally {
      sched.stop()
    }
  })
})

describe('S18 管理端点（手动对齐 + 调度配置）', () => {
  it('S18-3: 调度配置读取/保存/非法拒绝', async () => {
    ctx = await setupApp()
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const leadCookie = await loginCookie(ctx.app, 'zhangsan', 'pass-123456')

    const s = await authed(ctx.app, cookie, 'GET', '/api/v1/admin/settings')
    expect(s.body.scheduler).toEqual({
      extractionCron: '0 * * * *', alertCron: '*/15 * * * *', reportCron: '0 18 * * *',
      extractionEnabled: true, alertEnabled: true, reportEnabled: true,
    })

    const memberPut = await authed(ctx.app, leadCookie, 'PUT', '/api/v1/admin/settings/scheduler', {
      extractionCron: '*/10 * * * *', alertCron: '*/15 * * * *', reportCron: '0 9 * * *',
    })
    expect(memberPut.status).toBe(403)

    const bad = await authed(ctx.app, cookie, 'PUT', '/api/v1/admin/settings/scheduler', {
      extractionCron: '99 * * * *', alertCron: '*/15 * * * *', reportCron: '0 9 * * *',
    })
    expect(bad.status).toBe(400)
    expect(JSON.stringify(bad.body)).toMatch(/分/)

    const badToggle = await authed(ctx.app, cookie, 'PUT', '/api/v1/admin/settings/scheduler', {
      reportEnabled: 'yes',
    })
    expect(badToggle.status).toBe(400)
    expect(JSON.stringify(badToggle.body)).toMatch(/reportEnabled/)

    const ok = await authed(ctx.app, cookie, 'PUT', '/api/v1/admin/settings/scheduler', {
      extractionCron: '*/10 * * * *', alertCron: '*/20 * * * *', reportCron: '30 9 * * *',
      reportEnabled: false,
    })
    expect(ok.status).toBe(200)
    const after = await authed(ctx.app, cookie, 'GET', '/api/v1/admin/settings')
    expect(after.body.scheduler.extractionCron).toBe('*/10 * * * *')
    expect(after.body.scheduler.reportCron).toBe('30 9 * * *')
    expect(after.body.scheduler.reportEnabled).toBe(false)
    expect(after.body.scheduler.extractionEnabled).toBe(true) // 未覆盖项保持默认
  })

  it('S18-1: 立即对齐回显每渠道结果；单渠道失败不阻塞；成员 403；留审计', async () => {
    ctx = await setupApp()
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const leadCookie = await loginCookie(ctx.app, 'zhangsan', 'pass-123456')
    const p = await mkProject('客户S系统', ctx.members.lead.id)
    const ok = upsertChannel(ctx.db, { platform: 'feishu', groupKey: 'oc_ok', channelType: 'dedicated', projectId: p.id })
    const bad = upsertChannel(ctx.db, { platform: 'feishu', groupKey: 'oc_bad', channelType: 'dedicated', projectId: p.id })

    const denied = await authed(ctx.app, leadCookie, 'POST', '/api/v1/admin/extraction/run', {})
    expect(denied.status).toBe(403)

    const real = globalThis.fetch
    globalThis.fetch = async (url) => {
      const u = String(url)
      if (u.includes('tenant_access_token')) {
        return { ok: true, json: async () => ({ code: 0, tenant_access_token: 'tk' }) }
      }
      if (u.includes('container_id=oc_ok')) {
        return {
          ok: true,
          json: async () => ({
            code: 0,
            data: {
              items: [{ message_id: 'om_a', create_time: '1000', msg_type: 'text', sender: { id: 'fs_zhang' }, body: { content: '{"text":"后端联调完成"}' } }],
              has_more: false,
            },
          }),
        }
      }
      return { ok: true, json: async () => ({ code: 230002, msg: '机器人不在群内' }) }
    }
    try {
      const res = await authed(ctx.app, cookie, 'POST', '/api/v1/admin/extraction/run', {})
      expect(res.status).toBe(200)
      expect(res.body.channels).toHaveLength(2)
      const okRow = res.body.channels.find((c) => c.channelId === ok.id)
      const badRow = res.body.channels.find((c) => c.channelId === bad.id)
      expect(okRow.pulled).toBe(1)
      expect(okRow.events).toBe(1) // 无 LLM 配置 → 确定性降级产记录型事件
      expect(badRow.error).toMatch(/机器人不在群内/)
      // 游标：成功渠道推进、失败渠道不动
      const c1 = ctx.db.prepare('SELECT cursor FROM channels WHERE id = ?').get(ok.id)
      const c2 = ctx.db.prepare('SELECT cursor FROM channels WHERE id = ?').get(bad.id)
      expect(c1.cursor).toBe('1000')
      expect(c2.cursor).toBe(null)
      // 审计
      const audit = ctx.db.prepare(`SELECT * FROM audit_logs WHERE action = 'extraction.run'`).get()
      expect(audit).toBeTruthy()

      // channelId 过滤：只拉指定渠道
      const one = await authed(ctx.app, cookie, 'POST', '/api/v1/admin/extraction/run', { channelId: ok.id })
      expect(one.body.channels).toHaveLength(1)
      expect(one.body.channels[0].channelId).toBe(ok.id)
    } finally {
      globalThis.fetch = real
    }
  })
})

describe('S18-4: 日报当日去重（dailyReport）', () => {
  it('当日已推送不重复；未推送直接生成', async () => {
    ctx = await setupApp()
    const first = await dailyReport(ctx.db, { force: false })
    expect(first.skipped).toBeUndefined()
    expect(first.reports).toBeGreaterThanOrEqual(1)
    const again = await dailyReport(ctx.db, { force: false })
    expect(again.skipped).toBe(true)
    expect(again.reason).toMatch(/今日已推送/)
  })
})
