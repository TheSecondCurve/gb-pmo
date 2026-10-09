import { describe, it, expect, afterAll } from 'vitest'
import { setupApp, loginCookie, authed } from './helpers.mjs'

// 补丁型测试（engineering-standards §3 补丁层规矩：每条用例挂场景号，新增默认进场景文件）。
// API 面补齐：任务过滤、里程碑更新、渠道删除、管理员令牌治理、指标目录、个人梳理路由、login.ps1

let ctx
afterAll(() => ctx?.db.close())

describe('API 补齐（补丁层）', () => {
  it('S2/S17-12：任务过滤 / 里程碑更新 / 渠道删除', async () => {
    ctx = await setupApp()
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const p = await authed(ctx.app, cookie, 'POST', '/api/v1/projects', {
      name: '补齐项目', templateCode: 'lianmai_365', leadMemberId: ctx.members.lead.id,
    })
    // 过滤：按项目 + 按责任人 + 按状态（365连麦预置清单 14 条）
    const byProject = await authed(ctx.app, cookie, 'GET', `/api/v1/tasks?projectId=${p.body.id}`)
    expect(byProject.body.tasks.length).toBe(14)
    const byOwner = await authed(ctx.app, cookie, `GET`, `/api/v1/tasks?responsibleMemberId=${ctx.members.lead.id}&status=todo`)
    expect(byOwner.body.tasks.length).toBe(14)
    // 里程碑更新
    const ms = await authed(ctx.app, cookie, 'POST', '/api/v1/milestones', { projectId: p.body.id, name: '上线', planDate: '2026-11-01' })
    const msUpd = await authed(ctx.app, cookie, 'PATCH', `/api/v1/milestones/${ms.body.id}`, { planDate: '2026-11-15', status: 'met', actualDate: '2026-11-14' })
    expect(msUpd.body.planDate).toBe('2026-11-15')
    expect(msUpd.body.status).toBe('met')
    // 渠道增删
    const ch = await authed(ctx.app, cookie, 'POST', '/api/v1/channels', { platform: 'wecom', groupKey: 'wk_1', channelType: 'dedicated', projectId: p.body.id })
    expect((await authed(ctx.app, cookie, 'GET', '/api/v1/channels')).body.channels.length).toBe(1)
    await authed(ctx.app, cookie, 'DELETE', `/api/v1/channels/${ch.body.id}`)
    expect((await authed(ctx.app, cookie, 'GET', '/api/v1/channels')).body.channels.length).toBe(0)
  })

  it('S17 令牌治理 + S5 指标目录 + S16 个人梳理权限 + S4-1 login.ps1 + 登出', async () => {
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    // 普通成员签发令牌，管理员可吊销任意令牌
    const zc = await loginCookie(ctx.app, 'lisi', 'pass-123456')
    const tok = await authed(ctx.app, zc, 'POST', '/api/v1/auth/tokens', { scope: 'read', name: 'cli' })
    expect(tok.body.scope).toBe('read')
    const gov = await authed(ctx.app, cookie, 'GET', '/api/v1/admin/tokens')
    expect(gov.body.tokensByMember[tok.body.id]).toBeUndefined() // 按成员分组
    expect(Object.keys(gov.body.tokensByMember).length).toBeGreaterThanOrEqual(1)
    await authed(ctx.app, cookie, 'DELETE', `/api/v1/admin/tokens/${tok.body.id}`)

    // 指标目录（web 入口）
    const cat = await authed(ctx.app, cookie, 'GET', '/api/v1/metrics')
    expect(cat.body.metrics.length).toBe(8)

    // 个人梳理：成员只能生成自己的
    const mine = await authed(ctx.app, zc, 'POST', `/api/v1/members/${ctx.members.dev.id}/digest`)
    expect(mine.status).toBe(200)
    expect(mine.body.memberId).toBe(ctx.members.dev.id)
    const other = await authed(ctx.app, zc, 'POST', `/api/v1/members/${ctx.members.key.id}/digest`)
    expect(other.status).toBe(403)

    // login.ps1 纯 ASCII 且走 agent-login
    const ps1 = await ctx.app.inject({ method: 'GET', url: '/agent/login.ps1' })
    expect(ps1.statusCode).toBe(200)
    expect(/^[\x00-\x7F]*$/.test(ps1.body)).toBe(true) // eslint-disable-line no-control-regex -- 有意匹配控制字符：login.ps1/install.ps1 纯 ASCII 编码回归锚点
    expect(ps1.body).toContain('agent-login')

    // 登出后再登录恢复
    await authed(ctx.app, zc, 'POST', '/api/v1/auth/logout')
    expect((await authed(ctx.app, zc, 'GET', '/api/v1/auth/me')).status).toBe(401)
  })
})
