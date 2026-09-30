import { describe, it, expect } from 'vitest'
import { setupDb, setupApp } from './helpers.mjs'
import { today, bjDayStartMs, bjWeekStartMs } from '../db/time.js'
import { dailyReport } from '../brain/report.js'

// PRD S19：日历日一律北京时区（Asia/Shanghai，UTC+8）。全部用固定时刻断言，
// 结论不依赖跑测试机器的时区；「今天」类断言只比较工具与 BJ_TODAY 是否同源。

// 北京 2026-09-30（周三）10:00 = UTC 02:00 —— UTC 与北京同日
const BJ_MORNING = Date.UTC(2026, 8, 30, 2)
// 北京 2026-10-01 01:00 = UTC 09-30 17:00 —— UTC 还是 09-30，北京已跨日
const BJ_AFTER_MIDNIGHT = Date.UTC(2026, 8, 30, 17)
// 北京 2026-09-30 23:59:59 / 2026-10-01 00:00:00 的分界
const BJ_DAY_EDGE_LATE = Date.UTC(2026, 8, 30, 15, 59, 59)
const BJ_DAY_EDGE_NEXT = Date.UTC(2026, 8, 30, 16)

async function pat(app) {
  const res = await app.inject({
    method: 'POST', url: '/api/v1/auth/agent-login', payload: { username: 'admin', password: 'admin-pass-123' },
  })
  return res.json().token
}

async function agentSql(app, token, sql) {
  const res = await app.inject({
    method: 'POST', url: '/api/v1/agent/sql', payload: { sql }, headers: { authorization: `Bearer ${token}` },
  })
  return { status: res.statusCode, body: res.json() }
}

describe('S19 北京时区统一', () => {
  it('S19-1: today() 固定时刻取北京日历日（凌晨窗口不跟随 UTC 跨日）', () => {
    expect(today(new Date(BJ_MORNING))).toBe('2026-09-30')
    expect(today(BJ_MORNING)).toBe('2026-09-30') // 也接受 epoch 毫秒
    expect(today(new Date(BJ_AFTER_MIDNIGHT))).toBe('2026-10-01')
    expect(today(new Date(BJ_DAY_EDGE_LATE))).toBe('2026-09-30')
    expect(today(new Date(BJ_DAY_EDGE_NEXT))).toBe('2026-10-01')
  })

  it('S19-1: bjDayStartMs 取北京日零点（epoch 毫秒，与服务器时区无关）', () => {
    // 北京 09-30 零点 = UTC 09-29 16:00
    expect(bjDayStartMs(new Date(BJ_MORNING))).toBe(Date.UTC(2026, 8, 29, 16))
    expect(bjDayStartMs(new Date(BJ_AFTER_MIDNIGHT))).toBe(Date.UTC(2026, 8, 30, 16))
    expect(bjDayStartMs(new Date(BJ_MORNING))).toBe(bjDayStartMs(new Date(BJ_DAY_EDGE_LATE))) // 同一北京日零点相同
  })

  it('S19-1: bjWeekStartMs 取北京周一起点', () => {
    // 2026-09-30 是周三；北京本周一 = 09-28，零点 = UTC 09-27 16:00
    expect(bjWeekStartMs(new Date(BJ_MORNING))).toBe(Date.UTC(2026, 8, 27, 16))
    expect(bjWeekStartMs(new Date(Date.UTC(2026, 8, 28, 2)))).toBe(Date.UTC(2026, 8, 27, 16)) // 周一
    expect(bjWeekStartMs(new Date(Date.UTC(2026, 8, 27, 2)))).toBe(Date.UTC(2026, 8, 20, 16)) // 周日属上周
  })

  it('S19-2: BJ_TODAY() 为北京今日且与 today() 同源；BJ_TODAY(epoch) 按北京日历日取值', () => {
    const { db } = setupDb()
    try {
      expect(db.prepare('SELECT BJ_TODAY() AS d').get().d).toBe(today())
      expect(db.prepare('SELECT BJ_TODAY(?) AS d').get(BJ_MORNING).d).toBe('2026-09-30')
      expect(db.prepare('SELECT BJ_TODAY(?) AS d').get(BJ_AFTER_MIDNIGHT).d).toBe('2026-10-01')
      // 非法参数给出可读错误而非静默错值
      expect(() => db.prepare(`SELECT BJ_TODAY('abc') AS d`).get()).toThrow(/epoch/)
    } finally {
      db.close()
    }
  })

  it('S19-2: Agent SQL 裸 date("now")/datetime("now") 被 400 拒绝并提示 BJ_TODAY()；显式时区修饰放行', async () => {
    const ctx = await setupApp()
    try {
      const token = await pat(ctx.app)
      const bad1 = await agentSql(ctx.app, token, "SELECT COUNT(*) AS n FROM tasks WHERE plan_end_date < date('now')")
      expect(bad1.status).toBe(400)
      expect(bad1.body.message).toContain('BJ_TODAY')
      const bad2 = await agentSql(ctx.app, token, "SELECT datetime('now') AS t")
      expect(bad2.status).toBe(400)
      const ok = await agentSql(ctx.app, token, 'SELECT BJ_TODAY() AS d')
      expect(ok.status).toBe(200)
      expect(ok.body.rows[0].d).toBe(today())
      const okExplicit = await agentSql(ctx.app, token, "SELECT COUNT(*) AS n FROM tasks WHERE plan_end_date < date('now', '+8 hours')")
      expect(okExplicit.status).toBe(200)
    } finally {
      await ctx.db.close()
    }
  })

  it('S19-3: 日报「当日已发不重复」按北京日判定（北京昨日 23:30 的旧推送不算今日）', async () => {
    const ctx = await setupApp()
    try {
      const bjYesterdayLate = bjDayStartMs() - 30 * 60_000 // 北京昨日 23:30
      ctx.db
        .prepare(
          `INSERT INTO pushes (push_type, recipient_member_id, title, body, channel_platform, status, created_at)
           VALUES ('daily_report', ?, '旧日报', '', 'none', 'skipped', ?)`
        )
        .run(ctx.members.admin.id, bjYesterdayLate)
      const first = await dailyReport(ctx.db) // 北京昨日已发 ≠ 今日已发 → 照常发送
      expect(first.skipped).toBeUndefined()
      expect(first.reports).toBeGreaterThan(0)
      const second = await dailyReport(ctx.db) // 本轮已发（同北京日）→ 跳过
      expect(second.skipped).toBe(true)
    } finally {
      await ctx.db.close()
    }
  })
})
