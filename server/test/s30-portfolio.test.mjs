import { describe, it, expect, afterAll } from 'vitest'
import { setupApp, loginCookie, authed } from './helpers.mjs'
import { today } from '../db/time.js'

// PRD S30-1（v0.29）— 项目组合页数据契约：列表接口状态过滤 + 四个月期字段。
// 两者均为既有能力（SELECT p.* / ?status= 参数），组合页纯前端消费，此处补契约锚定防回归。

let ctx
afterAll(() => ctx?.db.close())

describe('S30 项目组合页数据契约', () => {
  it('S30-1: ?status=active,closed,cancelled 返回全部三态项目且行含四个月期字段；缺省仅进行中', async () => {
    ctx = await setupApp()
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const base = { templateCode: 'lianmai_365', leadMemberId: ctx.members.lead.id, tasks: [] }

    const a = await authed(ctx.app, cookie, 'POST', '/api/v1/projects', { ...base, name: '在跑甲' })
    expect(a.status).toBe(201)

    const b = await authed(ctx.app, cookie, 'POST', '/api/v1/projects', {
      ...base, name: '结项乙', planStartDate: '2026-08-01', planEndDate: '2026-08-31',
    })
    expect(b.status).toBe(201)
    const close = await authed(ctx.app, cookie, 'POST', `/api/v1/projects/${b.body.id}/close`, { summary: '交付完成' })
    expect(close.status).toBe(200)

    const c = await authed(ctx.app, cookie, 'POST', '/api/v1/projects', { ...base, name: '取消丙' })
    expect(c.status).toBe(201)
    const cancel = await authed(ctx.app, cookie, 'POST', `/api/v1/projects/${c.body.id}/cancel`, { reason: '战略调整' })
    expect(cancel.status).toBe(200)

    const all = await authed(ctx.app, cookie, 'GET', '/api/v1/projects?status=active,closed,cancelled')
    expect(all.status).toBe(200)
    const names = all.body.projects.map((p) => p.name)
    expect(names).toContain('在跑甲')
    expect(names).toContain('结项乙')
    expect(names).toContain('取消丙')

    const closed = all.body.projects.find((p) => p.name === '结项乙')
    expect(closed.status).toBe('closed')
    expect(closed.planStartDate).toBe('2026-08-01')
    expect(closed.planEndDate).toBe('2026-08-31')
    expect(closed.actualStartDate).toBeTruthy() // S29 启动日自动落
    expect(closed.actualEndDate).toBe(today()) // 终结落实际结束日（北京日历日）

    const def = await authed(ctx.app, cookie, 'GET', '/api/v1/projects')
    expect(def.body.projects.map((p) => p.name)).toEqual(['在跑甲']) // 缺省=仅进行中（既有行为不变）
  })
})
