// S26（v0.19）管理员诊断台：诊断 shell（开关默认关+审计+超时+截断）与飞书长连接三段自检。
// 安全不变量：仅管理员；shell 开关关闭时 400；每次执行留 audit_logs。
import { describe, it, expect } from 'vitest'
import { setupApp, loginCookie, authed } from './helpers.mjs'

async function adminCookie(app) {
  return loginCookie(app, 'admin', 'admin-pass-123')
}

describe('S26-1: 权限门禁（普通成员 403；开关默认关时管理员 400）', () => {
  it('S26: 普通成员调用诊断 shell 与飞书自检均 403', async () => {
    const { app } = await setupApp()
    const dev = await loginCookie(app, 'lisi', 'pass-123456')
    const shell = await authed(app, dev, 'POST', '/api/v1/admin/debug/shell', { command: 'echo hi' })
    expect(shell.status).toBe(403)
    const check = await authed(app, dev, 'POST', '/api/v1/admin/debug/feishu-selfcheck', {})
    expect(check.status).toBe(403)
  })

  it('S26: 未登录调用诊断接口 401', async () => {
    const { app } = await setupApp()
    const res = await app.inject({ method: 'POST', url: '/api/v1/admin/debug/shell', payload: { command: 'echo hi' } })
    expect(res.statusCode).toBe(401)
  })

  it('S26: shell 开关默认关，管理员执行被 400 拒绝并提示开启路径', async () => {
    const { app } = await setupApp()
    const admin = await adminCookie(app)
    const res = await authed(app, admin, 'POST', '/api/v1/admin/debug/shell', { command: 'echo hi' })
    expect(res.status).toBe(400)
    expect(res.body.message).toContain('shellEnabled')
    expect(res.body.message).toContain('运维诊断')
  })

  it('S26: shell 关闭时被拒的尝试也留审计', async () => {
    const { app, db } = await setupApp()
    const admin = await adminCookie(app)
    await authed(app, admin, 'POST', '/api/v1/admin/debug/shell', { command: 'echo hi' })
    const rows = db.prepare("SELECT detail FROM audit_logs WHERE action = 'debug.shell'").all()
    expect(rows.length).toBe(1)
    expect(rows[0].detail).toContain('echo hi')
  })
})

describe('S26-2: 开关开启后执行与审计', () => {
  async function enableShell(app) {
    const admin = await adminCookie(app)
    const put = await authed(app, admin, 'PUT', '/api/v1/admin/settings/debug', { shellEnabled: true })
    expect(put.status).toBe(200)
    return admin
  }

  it('S26: 执行 echo 回显 stdout/退出码，并落 debug.shell 审计（含命令与退出码）', async () => {
    const { app, db } = await setupApp()
    const admin = await enableShell(app)
    const res = await authed(app, admin, 'POST', '/api/v1/admin/debug/shell', { command: 'echo hello-pmo-debug' })
    expect(res.status).toBe(200)
    expect(res.body.stdout).toContain('hello-pmo-debug')
    expect(res.body.code).toBe(0)
    expect(res.body.timedOut).toBe(false)
    const rows = db.prepare("SELECT detail FROM audit_logs WHERE action = 'debug.shell' AND detail LIKE '%hello-pmo-debug%'").all()
    expect(rows.length).toBe(1)
    expect(rows[0].detail).toContain('"code":0')
  })

  it('S26: stderr 与非零退出码如实回显', async () => {
    const { app } = await setupApp()
    const admin = await enableShell(app)
    const res = await authed(app, admin, 'POST', '/api/v1/admin/debug/shell', { command: 'echo boom >&2; exit 3' })
    expect(res.status).toBe(200)
    expect(res.body.stderr).toContain('boom')
    expect(res.body.code).toBe(3)
  })

  it('S26: command 缺失 400', async () => {
    const { app } = await setupApp()
    const admin = await enableShell(app)
    const res = await authed(app, admin, 'POST', '/api/v1/admin/debug/shell', {})
    expect(res.status).toBe(400)
  })
})

describe('S26-3: 超时与输出截断', () => {
  it('S26: 超过 debug.timeoutMs 终止并回 timedOut=true，请求不挂死', async () => {
    const { app } = await setupApp()
    const admin = await adminCookie(app)
    await authed(app, admin, 'PUT', '/api/v1/admin/settings/debug', { shellEnabled: true, timeoutMs: 1000 })
    const res = await authed(app, admin, 'POST', '/api/v1/admin/debug/shell', { command: 'sleep 5' })
    expect(res.status).toBe(200)
    expect(res.body.timedOut).toBe(true)
  }, 15000)

  it('S26: 输出超过 debug.maxOutputBytes 截断并标 truncated=true', async () => {
    const { app } = await setupApp()
    const admin = await adminCookie(app)
    const cap = 64 * 1024
    await authed(app, admin, 'PUT', '/api/v1/admin/settings/debug', { shellEnabled: true, maxOutputBytes: cap })
    const res = await authed(app, admin, 'POST', '/api/v1/admin/debug/shell', {
      command: 'head -c 200000 /dev/zero | tr "\\0" x',
    })
    expect(res.status).toBe(200)
    expect(res.body.truncated).toBe(true)
    expect(res.body.stdout.length).toBeLessThanOrEqual(cap)
  }, 15000)
})

describe('S26-4: 飞书长连接自检', () => {
  it('S26: 凭证未配置时第①段即失败并回配置指引（不发外网）', async () => {
    const { app, db } = await setupApp()
    const admin = await adminCookie(app)
    const res = await authed(app, admin, 'POST', '/api/v1/admin/debug/feishu-selfcheck', {})
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(false)
    expect(res.body.stages[0].stage).toBe('token')
    expect(res.body.stages[0].ok).toBe(false)
    expect(res.body.stages[0].reason).toContain('appId')
    const rows = db.prepare("SELECT detail FROM audit_logs WHERE action = 'debug.feishuSelfcheck'").all()
    expect(rows.length).toBe(1)
  })
})
