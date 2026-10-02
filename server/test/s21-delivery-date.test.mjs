import { describe, it, expect, afterAll } from 'vitest'
import { setupApp, loginCookie, authed } from './helpers.mjs'
import { today } from '../db/time.js'

// PRD S21（v0.28 改写）— 交付日期派生口径：选填；填了派生「剩余 N 天 / 超期 N 天」（北京日历日）；
// 可自由填写/修改/清空；结项/取消后不再派生（null）。
// 交付日期相对 today() 动态取值，避免「固定日期跑过即红」的时间炸弹（同 S18 教训）。

let ctx
afterAll(() => { ctx?.db.close() })

const dayOff = (n) => new Date(Date.parse(`${today()}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

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

describe('S21 交付日期派生口径（v0.28）', () => {
  it('S21-1: 选填；填了派生剩余/超期天数，可自由改/清空；列表行同口径', async () => {
    ctx = await setupApp()
    const cookie = await admin()
    // 立项即进行中（S29），无交付日期 → 不派生
    const p = await mkProject('无交付日项目')
    expect(p.status).toBe('active')
    expect(p.daysToDelivery).toBeNull()

    // 填交付日期 → 派生剩余天数；改期 → 重新派生；过往日期 → 负值=超期
    const filled = await authed(ctx.app, cookie, 'PATCH', `/api/v1/projects/${p.id}`, { planEndDate: dayOff(10) })
    expect(filled.status).toBe(200)
    expect(filled.body.daysToDelivery).toBe(10)
    const late = await authed(ctx.app, cookie, 'PATCH', `/api/v1/projects/${p.id}`, { planEndDate: dayOff(-3) })
    expect(late.body.daysToDelivery).toBe(-3)

    // 可清空（v0.28：守门规则作废）
    const cleared = await authed(ctx.app, cookie, 'PATCH', `/api/v1/projects/${p.id}`, { planEndDate: '' })
    expect(cleared.status).toBe(200)
    expect(cleared.body.planEndDate).toBeNull()
    expect(cleared.body.daysToDelivery).toBeNull()

    // 全局列表行同样派生
    const back = await authed(ctx.app, cookie, 'PATCH', `/api/v1/projects/${p.id}`, { planEndDate: dayOff(10) })
    expect(back.status).toBe(200)
    const list = await authed(ctx.app, cookie, 'GET', '/api/v1/projects')
    const row = list.body.projects.find((x) => x.id === p.id)
    expect(row.daysToDelivery).toBe(10)
  })

  it('S21-2: 结项/取消后不再派生剩余天数（null）', async () => {
    ctx = await setupApp()
    const cookie = await admin()
    // 结项 → null
    const p = await mkProject('交付在即', { planEndDate: dayOff(10) })
    expect(p.daysToDelivery).toBe(10)
    const closed = await authed(ctx.app, cookie, 'POST', `/api/v1/projects/${p.id}/close`, { summary: '交付完成' })
    expect(closed.status).toBe(200)
    expect(closed.body.daysToDelivery).toBeNull()

    // 取消 → null
    const q = await mkProject('中途取消', { planEndDate: dayOff(10) })
    expect(q.daysToDelivery).toBe(10)
    const cancelled = await authed(ctx.app, cookie, 'POST', `/api/v1/projects/${q.id}/cancel`, { reason: '客户预算砍了' })
    expect(cancelled.status).toBe(200)
    expect(cancelled.body.daysToDelivery).toBeNull()
  })
})
