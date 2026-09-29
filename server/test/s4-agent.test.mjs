import { describe, it, expect, afterAll } from 'vitest'
import { setupApp, loginCookie, authed } from './helpers.mjs'

// PRD S4 + engineering-standards §4 SQL 端点对抗用例表 — 形态 B 接入与安全判定

let ctx
let writeToken
let readToken
afterAll(() => ctx?.db.close())

async function agent(method, url, payload, token = writeToken, headers = {}) {
  const res = await ctx.app.inject({
    method, url, payload, headers: { authorization: `Bearer ${token}`, ...headers },
  })
  let body = null
  try { body = res.json() } catch { body = res.body }
  return { status: res.statusCode, body }
}

async function sql(statement, token) {
  return agent('POST', '/api/v1/agent/sql', { sql: statement }, token)
}

describe('S4 Agent 接入（形态 B）', () => {
  it('S4-1: 一条命令装 skill 与授权：login.sh/install.sh/SKILL.md/client.sh 均可下发，脚本含服务地址与版本', async () => {
    ctx = await setupApp()
    const login = await ctx.app.inject({ method: 'GET', url: '/agent/login.sh' })
    expect(login.statusCode).toBe(200)
    expect(login.body).toContain('/api/v1/auth/agent-login')
    expect(login.body).toContain('/dev/tty')
    const install = await ctx.app.inject({ method: 'GET', url: '/agent/skill/gb-pmo/install.sh' })
    expect(install.statusCode).toBe(200)
    expect(install.body).toContain('.agents/skills')
    expect(install.body).toContain('SKILL.md')
    const skill = await ctx.app.inject({ method: 'GET', url: '/agent/skill/gb-pmo/SKILL.md' })
    expect(skill.statusCode).toBe(200)
    expect(skill.body).toContain('gb-pmo')
    const client = await ctx.app.inject({ method: 'GET', url: '/agent/skill/gb-pmo/client.sh' })
    expect(client.statusCode).toBe(200)
    expect(client.body).toContain('agent/sql')
    // install.ps1 纯 ASCII
    const ps1 = await ctx.app.inject({ method: 'GET', url: '/agent/skill/gb-pmo/install.ps1' })
    expect(ps1.statusCode).toBe(200)
    expect(/^[\x00-\x7F]*$/.test(ps1.body)).toBe(true)
  })

  it('S4-1: 终端授权换 PAT（agent-login）', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/v1/auth/agent-login', payload: { username: 'zhangsan', password: 'pass-123456' },
    })
    expect(res.statusCode).toBe(200)
    writeToken = res.json().token
    expect(writeToken.startsWith('pmo_')).toBe(true)
    const bad = await ctx.app.inject({
      method: 'POST', url: '/api/v1/auth/agent-login', payload: { username: 'zhangsan', password: 'wrong' },
    })
    expect(bad.statusCode).toBe(401)
  })

  it('S4-2: 「我本周的任务」经 SQL 端点返回名下未完成任务', async () => {
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const p = await authed(ctx.app, cookie, 'POST', '/api/v1/projects', {
      name: '客户M系统', templateCode: 'software_delivery', leadMemberId: ctx.members.lead.id,
    })
    // 完成一项，剩 5 项未完
    await authed(ctx.app, cookie, 'PATCH', `/api/v1/tasks/${p.body.tasks[0].id}`, { status: 'done' })
    const res = await sql(
      `SELECT id, title, plan_end_date FROM tasks WHERE responsible_member_id = ${ctx.members.lead.id} AND status IN ('todo','doing','blocked') ORDER BY id`
    )
    expect(res.status).toBe(200)
    expect(res.body.rows.length).toBe(5)
    expect(Array.isArray(res.body.rows)).toBe(true)
  })

  it('S4-3: 口述「验收推迟到 10 月 20」→ 建议型事件，确认后里程碑日期生效并留痕', async () => {
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const p = await authed(ctx.app, cookie, 'POST', '/api/v1/projects', {
      name: '客户N系统', templateCode: 'software_delivery', leadMemberId: ctx.members.lead.id,
    })
    const ms = await authed(ctx.app, cookie, 'POST', '/api/v1/milestones', { projectId: p.body.id, name: '客户验收', planDate: '2026-10-10' })
    // Agent 口述 → 写入建议型事件（SKILL 守则：nature=suggestion 不直接改）
    const ins = await sql(
      `INSERT INTO project_events (project_id, business_time, created_at, nature, event_type, summary, source_platform, speaker_member_id, speaker_label, status, target_object, target_task_id, target_field, target_value, generated_by, pushed_to)
       VALUES (${p.body.id}, strftime('%s','now')*1000, strftime('%s','now')*1000, 'suggestion', 'schedule_change', '客户N验收推迟到 2026-10-20', 'agent', ${ctx.members.lead.id}, '张三', 'pending', 'milestone', ${ms.body.id}, 'plan_date', '2026-10-20', 'agent', '[]')`
    )
    expect(ins.status).toBe(200)
    const pend = await authed(ctx.app, cookie, 'GET', `/api/v1/projects/${p.body.id}/events?status=pending`)
    const evt = pend.body.events.find((e) => e.summary.includes('验收推迟'))
    const confirm = await authed(ctx.app, cookie, 'POST', `/api/v1/events/${evt.id}/confirm`)
    expect(confirm.status).toBe(200)
    expect(confirm.body.status).toBe('effective')
    const row = ctx.db.prepare('SELECT plan_date FROM milestones WHERE id = ?').get(ms.body.id)
    expect(row.plan_date).toBe('2026-10-20')
  })

  it('S4-4: 口述「这块交给小王」→ 确认后责任人变更为王五', async () => {
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const p = await authed(ctx.app, cookie, 'POST', '/api/v1/projects', {
      name: '客户O系统', templateCode: 'software_delivery', leadMemberId: ctx.members.lead.id,
    })
    const task = p.body.tasks[2]
    const ins = await sql(
      `INSERT INTO project_events (project_id, business_time, created_at, nature, event_type, summary, source_platform, speaker_member_id, speaker_label, status, target_object, target_task_id, target_field, target_value, generated_by, pushed_to)
       VALUES (${p.body.id}, strftime('%s','now')*1000, strftime('%s','now')*1000, 'suggestion', 'owner_change', '这块交给王五', 'agent', ${ctx.members.lead.id}, '张三', 'pending', 'task', ${task.id}, 'responsible_member_id', '${ctx.members.key.id}', 'agent', '[]')`
    )
    expect(ins.status).toBe(200)
    const events = await authed(ctx.app, cookie, 'GET', `/api/v1/projects/${p.body.id}/events?status=pending`)
    const evt = events.body.events.find((e) => e.targetField === 'responsible_member_id')
    await authed(ctx.app, cookie, 'POST', `/api/v1/events/${evt.id}/confirm`)
    const t = ctx.db.prepare('SELECT responsible_member_id FROM tasks WHERE id = ?').get(task.id)
    expect(t.responsible_member_id).toBe(ctx.members.key.id)
  })

  it('S4-5: 触发类功能经 action 白名单与权限校验并记审计；read scope 拒绝；未知 action 拒绝', async () => {
    const readRes = await ctx.app.inject({
      method: 'POST', url: '/api/v1/auth/tokens', payload: { scope: 'read' },
      headers: { cookie: await loginCookie(ctx.app, 'zhangsan', 'pass-123456') },
    })
    readToken = readRes.json().token

    const denied = await agent('POST', '/api/v1/agent/actions', { action: 'generate_person_digest' }, readToken)
    expect(denied.status).toBe(403)

    const unknown = await agent('POST', '/api/v1/agent/actions', { action: 'drop_all_tables' })
    expect(unknown.status).toBe(400)
    expect(unknown.body.message).toContain('白名单')

    const ok = await agent('POST', '/api/v1/agent/actions', { action: 'generate_person_digest', params: { memberId: ctx.members.lead.id } })
    expect(ok.status).toBe(200)
    expect(ok.body.ok).toBe(true)
    const auditRow = ctx.db.prepare(`SELECT * FROM audit_logs WHERE action = 'agent.action.generate_person_digest'`).get()
    expect(auditRow).toBeTruthy()
  })
})

describe('SQL 端点对抗用例表（engineering-standards §4）', () => {
  it('注释前缀绕过：/* */ SELECT 视为读；-- 注释头同理', async () => {
    const res = await sql('/* just a comment */ SELECT COUNT(*) AS n FROM projects')
    expect(res.status).toBe(200)
    const res2 = await sql('-- note\nSELECT 1 AS one')
    expect(res2.status).toBe(200)
  })

  it('WITH...DELETE 落写分支：read scope 403', async () => {
    const res = await sql('WITH t AS (SELECT 1) DELETE FROM tasks', readToken)
    expect(res.status).toBe(403)
  })

  it('多语句拒绝（prepare 单语句约束）', async () => {
    const res = await sql('SELECT 1; DELETE FROM tasks')
    expect(res.status).toBe(400)
  })

  it('PRAGMA 改连接状态：一律 403（prepare 之前判定）', async () => {
    const res = await sql('PRAGMA writable_schema = 1')
    expect(res.status).toBe(403)
  })

  it('SELECTX 前缀误判：不匹配读写头 → 403', async () => {
    const res = await sql('SELECTX * FROM tasks')
    expect(res.status).toBe(403)
  })

  it('凭据列与 sessions 表黑名单 → 403', async () => {
    expect((await sql('SELECT password_hash FROM members')).status).toBe(403)
    expect((await sql('SELECT * FROM sessions')).status).toBe(403)
    expect((await sql("UPDATE members SET token_hash = 'x' WHERE id = 1")).status).toBe(403)
  })

  it('read scope 执行 UPDATE → 403；write scope 可写并留审计', async () => {
    expect((await sql("UPDATE tasks SET plan_start_date = '2026-10-01' WHERE id = 999", readToken)).status).toBe(403)
    const res = await sql("INSERT INTO milestones (project_id, name, plan_date, status, created_at, updated_at) VALUES (1, 'agent建', '2026-10-30', 'planned', strftime('%s','now')*1000, strftime('%s','now')*1000)")
    expect(res.status).toBe(200)
    expect(ctx.db.prepare(`SELECT * FROM audit_logs WHERE action = 'agent.sql.write'`).get()).toBeTruthy()
  })

  it('读上限 1000 行截断标记；rows 用数组', async () => {
    for (let i = 0; i < 1200; i++) {
      ctx.db.prepare(`INSERT INTO unrouted_messages (platform, group_key, business_time, speaker_label, content, status, created_at) VALUES ('feishu','g',0,'x','m${i}','discarded',0)`).run()
    }
    const res = await sql('SELECT id FROM unrouted_messages')
    expect(res.status).toBe(200)
    expect(res.body.count).toBe(1000)
    expect(res.body.truncated).toBe(true)
  })

  it('cookie 一律 403；无 Bearer 401；吊销后 401', async () => {
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const withCookie = await ctx.app.inject({
      method: 'POST', url: '/api/v1/agent/sql', payload: { sql: 'SELECT 1' }, headers: { cookie, authorization: `Bearer ${writeToken}` },
    })
    expect(withCookie.statusCode).toBe(403)
    const noAuth = await ctx.app.inject({ method: 'POST', url: '/api/v1/agent/sql', payload: { sql: 'SELECT 1' } })
    expect(noAuth.statusCode).toBe(401)
    // 吊销（令牌属张三，用张三会话管理）
    const zhangCookie = await loginCookie(ctx.app, 'zhangsan', 'pass-123456')
    const tokens = await authed(ctx.app, zhangCookie, 'GET', '/api/v1/auth/tokens')
    const mine = tokens.body.tokens.find((t) => !t.revokedAt && t.scope === 'write' && t.name === 'agent-cli')
    await authed(ctx.app, zhangCookie, 'DELETE', `/api/v1/auth/tokens/${mine.id}`)
    const revoked = await sql('SELECT 1')
    expect(revoked.status).toBe(401)
    writeToken = readToken // 后续用例换有效令牌
  })
})
