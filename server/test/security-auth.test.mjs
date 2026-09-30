import { describe, it, expect, afterAll } from 'vitest'
import { setupApp, loginCookie, authed, setupDb } from './helpers.mjs'
import { bootstrapAdmin, issueToken, authenticateToken, hashPassword, verifyPassword } from '../engine/auth.js'

// engineering-standards §4 必测清单：bootstrap 拒启、权限矩阵、401/403、令牌过期

let ctx
afterAll(() => ctx?.db.close())

describe('认证边界', () => {
  it('bootstrap：空库且缺管理员凭据 → 拒绝启动', () => {
    const { db } = setupDb()
    expect(() => bootstrapAdmin(db, {})).toThrow(/GB_PMO_ADMIN/)
    const n = bootstrapAdmin(db, { username: 'boss', password: 'init-pass-123' })
    expect(n).toBe(true)
    // 已有成员后再次 bootstrap 不重复创建
    expect(bootstrapAdmin(db, { username: 'x', password: 'y' })).toBe(false)
    db.close()
  })

  it('密码：scrypt 哈希可验证、错密拒绝', () => {
    const h = hashPassword('s3cret-pass')
    expect(verifyPassword('s3cret-pass', h)).toBe(true)
    expect(verifyPassword('wrong', h)).toBe(false)
    expect(verifyPassword('x', null)).toBe(false)
  })

  it('未登录 401；错密 401；普通成员访问管理端点 403（can() 矩阵）', async () => {
    ctx = await setupApp()
    const anon = await ctx.app.inject({ method: 'GET', url: '/api/v1/members' })
    expect(anon.statusCode).toBe(401)
    const bad = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'nope' } })
    expect(bad.statusCode).toBe(401)

    const memberCookie = await loginCookie(ctx.app, 'lisi', 'pass-123456')
    for (const [method, url] of [
      ['POST', '/api/v1/members'],
      ['PATCH', `/api/v1/members/3`],
      ['GET', '/api/v1/admin/settings'],
      ['PUT', '/api/v1/admin/settings/thresholds'],
      ['GET', '/api/v1/admin/todo'],
      ['POST', '/api/v1/admin/test-llm'],
      ['DELETE', '/api/v1/admin/tokens/1'],
      ['GET', '/api/v1/admin/templates'],
      ['POST', '/api/v1/admin/project-types'],
      ['PATCH', '/api/v1/admin/project-types/1'],
      ['POST', '/api/v1/admin/templates'],
      ['DELETE', '/api/v1/admin/templates/99'],
    ]) {
      const res = await authed(ctx.app, memberCookie, method, url, {})
      expect(res.status).toBe(403)
    }
    // 全员透明（D1）：普通成员可读成员表与项目
    const ok = await authed(ctx.app, memberCookie, 'GET', '/api/v1/members')
    expect(ok.status).toBe(200)
    const ok2 = await authed(ctx.app, memberCookie, 'GET', '/api/v1/metrics/running_projects/query')
    expect(ok2.status).toBe(200)
  })

  it('令牌过期与吊销后 401', async () => {
    const { db } = setupDb()
    bootstrapAdmin(db, { username: 'a', password: 'init-pass-123' })
    const mid = db.prepare('SELECT id FROM members LIMIT 1').get().id
    const expired = issueToken(db, mid, { ttlDays: -1 })
    expect(authenticateToken(db, expired.token)).toBeNull()
    const ok = issueToken(db, mid, {})
    expect(authenticateToken(db, ok.token)).toBeTruthy()
    db.prepare('UPDATE tokens SET revoked_at = ? WHERE id = ?').run(Date.now(), ok.id)
    expect(authenticateToken(db, ok.token)).toBeNull()
    db.close()
  })

  it('登出销毁会话；会话 cookie 签名防篡改', async () => {
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const me = await authed(ctx.app, cookie, 'GET', '/api/v1/auth/me')
    expect(me.body.member.name).toBe('管理员')
    await authed(ctx.app, cookie, 'POST', '/api/v1/auth/logout')
    const after = await authed(ctx.app, cookie, 'GET', '/api/v1/auth/me')
    expect(after.status).toBe(401)
    const forged = `pmo_session=${cookie.split('=')[1].slice(0, -2)}xy`
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: forged } })
    expect(res.statusCode).toBe(401)
  })

  it('S17-7: 最后一名在职系统管理员不可被降级/离职；存在第二名时允许', async () => {
    const local = await setupApp()
    try {
      const cookie = await loginCookie(local.app, 'admin', 'admin-pass-123')
      // 唯一在职 admin：降级自己 → 409
      const demote = await authed(local.app, cookie, 'PATCH', `/api/v1/members/${local.members.admin.id}`, { role: 'member' })
      expect(demote.status).toBe(409)
      expect(demote.body.message).toContain('系统管理员')
      // 唯一在职 admin：离职 → 409（先补一名普通成员接管，绕开转交 409，验证的是角色保护）
      await authed(local.app, cookie, 'POST', '/api/v1/members', { name: '小明', username: 'xiaoming', password: 'pass-123456' })
      const offboard = await authed(local.app, cookie, 'POST', `/api/v1/members/${local.members.admin.id}/offboard`, {
        handover: { tasks: [], projects: [] },
      })
      expect(offboard.status).toBe(409)
      expect(offboard.body.message).toContain('系统管理员')
      // 指定第二名系统管理员后，原管理员可降级
      const promote = await authed(local.app, cookie, 'PATCH', `/api/v1/members/${local.members.dev.id}`, { role: 'admin' })
      expect(promote.status).toBe(200)
      expect(promote.body.member.role).toBe('admin')
      const demote2 = await authed(local.app, cookie, 'PATCH', `/api/v1/members/${local.members.admin.id}`, { role: 'member' })
      expect(demote2.status).toBe(200)
      expect(demote2.body.member.role).toBe('member')
    } finally {
      local.db.close()
    }
  })
})
