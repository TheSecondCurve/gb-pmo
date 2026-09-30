import { describe, it, expect, afterAll } from 'vitest'
import { setupApp, loginCookie, authed } from './helpers.mjs'
import { today } from '../db/time.js'

// PRD S21 — 交付日期一等公民（v0.12）：切「进行中」强制非空；交付周期派生剩余/超期天数（北京日历日）。
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

describe('S21 交付日期与交付周期', () => {
  it('S21-1: 未填交付日期切「进行中」被拒绝；同请求补齐交付日期则放行', async () => {
    ctx = await setupApp()
    const cookie = await admin()
    const p = await mkProject('无交付日项目')
    const denied = await authed(ctx.app, cookie, 'PATCH', `/api/v1/projects/${p.id}`, { status: 'active' })
    expect(denied.status).toBe(400)
    expect(denied.body.message).toMatch(/交付日期/)

    const both = await authed(ctx.app, cookie, 'PATCH', `/api/v1/projects/${p.id}`, { status: 'active', planEndDate: dayOff(5) })
    expect(both.status).toBe(200)
    expect(both.body.status).toBe('active')
  })

  it('S21-2: 激活自动落启动日并派生剩余天数（未来为正/已过为负；结项后不再计算）', async () => {
    ctx = await setupApp()
    const cookie = await admin()
    const p = await mkProject('交付在即', { planStartDate: today(), planEndDate: dayOff(10) })
    const act = await authed(ctx.app, cookie, 'PATCH', `/api/v1/projects/${p.id}`, { status: 'active' })
    expect(act.status).toBe(200)
    expect(act.body.actualStartDate).toBe(today())
    expect(act.body.daysToDelivery).toBe(10)

    const late = await mkProject('已超期项目', { planEndDate: dayOff(-3) })
    const act2 = await authed(ctx.app, cookie, 'PATCH', `/api/v1/projects/${late.id}`, { status: 'active' })
    expect(act2.body.daysToDelivery).toBe(-3)

    // 全局列表行同样派生
    const list = await authed(ctx.app, cookie, 'GET', '/api/v1/projects')
    const row = list.body.projects.find((x) => x.id === p.id)
    expect(row.daysToDelivery).toBe(10)
    const lateRow = list.body.projects.find((x) => x.id === late.id)
    expect(lateRow.daysToDelivery).toBe(-3)

    // 结项后不再计算剩余天数
    const closed = await authed(ctx.app, cookie, 'POST', `/api/v1/projects/${p.id}/close`, { summary: '交付完成' })
    expect(closed.status).toBe(200)
    expect(closed.body.daysToDelivery).toBeNull()
  })

  it('S21-3: 进行中/已暂停项目不可清空交付日期；待启动可以', async () => {
    ctx = await setupApp()
    const cookie = await admin()
    const p = await mkProject('清空校验', { planEndDate: dayOff(30) })
    const act = await authed(ctx.app, cookie, 'PATCH', `/api/v1/projects/${p.id}`, { status: 'active' })
    expect(act.status).toBe(200)

    const clear = await authed(ctx.app, cookie, 'PATCH', `/api/v1/projects/${p.id}`, { planEndDate: '' })
    expect(clear.status).toBe(400)
    expect(clear.body.message).toMatch(/交付日期/)

    const pause = await authed(ctx.app, cookie, 'PATCH', `/api/v1/projects/${p.id}`, { status: 'paused' })
    expect(pause.status).toBe(200)
    const clear2 = await authed(ctx.app, cookie, 'PATCH', `/api/v1/projects/${p.id}`, { planEndDate: '' })
    expect(clear2.status).toBe(400)

    // 待启动项目可清空（尚未进入交付周期）
    const p2 = await mkProject('待启动清空', { planEndDate: dayOff(30) })
    const clear3 = await authed(ctx.app, cookie, 'PATCH', `/api/v1/projects/${p2.id}`, { planEndDate: '' })
    expect(clear3.status).toBe(200)
    expect(clear3.body.planEndDate).toBeNull()
  })
})
