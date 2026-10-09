import { describe, it, expect, afterAll } from 'vitest'
import { setupApp, loginCookie, authed } from './helpers.mjs'
import { upsertChannel } from '../engine/tasks.js'
import { today, addDays } from '../db/time.js'

// PRD S37 — 项目硬删除（物理删除，v0.41）：与「取消」互补的技术语义（K19：软删约定唯一例外）。
// 仅系统管理员（web requireAdmin + Agent delete_project adminOnly）；任意状态可直接删；
// 同事务级联抹除任务面/讨论面，分拣暂存与推送历史置 NULL 保留；唯一痕迹 = project.hardDelete 审计快照。

let ctx
afterAll(() => ctx?.db.close())

async function admin() {
  return loginCookie(ctx.app, 'admin', 'admin-pass-123')
}

async function mkProject(name) {
  const res = await authed(ctx.app, await admin(), 'POST', '/api/v1/projects', {
    name, templateCode: 'lianmai_365', leadMemberId: ctx.members.lead.id, planEndDate: addDays(today(), 30),
  })
  if (res.status !== 201) throw new Error(`mkProject failed: ${res.status} ${JSON.stringify(res.body)}`)
  return res.body
}

async function agent(method, url, payload, token) {
  const res = await ctx.app.inject({ method, url, payload, headers: { authorization: `Bearer ${token}` } })
  return { status: res.statusCode, body: res.json() }
}

/** 给项目造满级联面：任务参考/更新记录/事件/里程碑/渠道绑定/日历映射 + 分拣暂存/推送历史引用。 */
async function fillProjectFace(p) {
  const cookie = await admin()
  const taskId = p.tasks[0].id
  await authed(ctx.app, cookie, 'POST', `/api/v1/tasks/${taskId}/refs`, { title: 'SOP', url: 'https://wiki.example.com/sop' })
  await authed(ctx.app, cookie, 'POST', `/api/v1/tasks/${taskId}/records`, { content: '进展一条' })
  await authed(ctx.app, cookie, 'POST', `/api/v1/projects/${p.id}/events`, { eventType: 'progress', nature: 'record', summary: '快照' })
  await authed(ctx.app, cookie, 'POST', '/api/v1/milestones', { projectId: p.id, name: '首版上线', planDate: addDays(today(), 7) })
  upsertChannel(ctx.db, { platform: 'feishu', groupKey: `oc_${p.id}`, name: '专题群', channelType: 'dedicated', projectId: p.id }, ctx.members.admin.id)
  ctx.db.prepare(`INSERT INTO calendar_sync (project_id, calendar_event_id, content_hash, synced_at) VALUES (?, 'evt_x', 'h', ?)`).run(p.id, Date.now())
  ctx.db.prepare(
    `INSERT INTO unrouted_messages (platform, group_key, business_time, content, routed_project_id, created_at) VALUES ('feishu', 'oc_g', ?, '暂存消息', ?, ?)`
  ).run(Date.now(), p.id, Date.now())
  ctx.db.prepare(
    `INSERT INTO pushes (push_type, recipient_member_id, related_project_id, title, body, created_at) VALUES ('digest', ?, ?, '推送', '正文', ?)`
  ).run(ctx.members.lead.id, p.id, Date.now())
}

const count = (sql, id) => ctx.db.prepare(sql).get(id).n

describe('S37 项目硬删除（物理删除）', () => {
  it('S37-1: 管理员硬删在跑项目 → 任务/refs/records/事件/里程碑/渠道/日历映射同事务物理抹除', async () => {
    ctx = await setupApp()
    const cookie = await admin()
    const p = await mkProject('硬删项目')
    await fillProjectFace(p)

    const del = await authed(ctx.app, cookie, 'DELETE', `/api/v1/projects/${p.id}`)
    expect(del.status).toBe(200)
    expect(del.body.ok).toBe(true)

    expect(count('SELECT COUNT(*) AS n FROM projects WHERE id = ?', p.id)).toBe(0)
    expect(count('SELECT COUNT(*) AS n FROM tasks WHERE project_id = ?', p.id)).toBe(0)
    expect(count('SELECT COUNT(*) AS n FROM milestones WHERE project_id = ?', p.id)).toBe(0)
    expect(count('SELECT COUNT(*) AS n FROM project_events WHERE project_id = ?', p.id)).toBe(0)
    expect(count('SELECT COUNT(*) AS n FROM channels WHERE project_id = ?', p.id)).toBe(0)
    expect(count('SELECT COUNT(*) AS n FROM calendar_sync WHERE project_id = ?', p.id)).toBe(0)
    // 任务子表随 tasks 一并消失
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM task_refs').get().n).toBe(0)
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM task_records').get().n).toBe(0)
    // 详情/列表读侧 404 与消失
    expect((await authed(ctx.app, cookie, 'GET', `/api/v1/projects/${p.id}`)).status).toBe(404)
    const list = await authed(ctx.app, cookie, 'GET', '/api/v1/projects')
    expect(list.body.projects.find((x) => x.id === p.id)).toBeUndefined()
  })

  it('S37-2: 删除落 project.hardDelete 审计快照；分拣暂存与推送历史行保留、项目引用置 NULL', async () => {
    const cookie = await admin()
    const p = await mkProject('硬删留痕项目')
    await fillProjectFace(p)
    const taskCount = p.tasks.length

    expect((await authed(ctx.app, cookie, 'DELETE', `/api/v1/projects/${p.id}`)).status).toBe(200)

    const auditRow = ctx.db.prepare(`SELECT * FROM audit_logs WHERE action = 'project.hardDelete' AND object_id = ?`).get(String(p.id))
    expect(auditRow).toBeTruthy()
    expect(auditRow.detail).toContain('硬删留痕项目') // 项目名快照
    expect(auditRow.detail).toContain(`"tasks":${taskCount}`)
    // 分拣暂存/推送历史：行保留、引用置 NULL
    const unrouted = ctx.db.prepare('SELECT routed_project_id FROM unrouted_messages').get()
    expect(unrouted).toBeTruthy()
    expect(unrouted.routed_project_id).toBeNull()
    const push = ctx.db.prepare('SELECT related_project_id FROM pushes').get()
    expect(push).toBeTruthy()
    expect(push.related_project_id).toBeNull()
  })

  it('S37-3: 普通成员 403；未登录 401；项目不存在 404', async () => {
    const cookie = await admin()
    const p = await mkProject('权限项目')
    const zc = await loginCookie(ctx.app, 'lisi', 'pass-123456')
    const denied = await authed(ctx.app, zc, 'DELETE', `/api/v1/projects/${p.id}`)
    expect(denied.status).toBe(403)
    expect(count('SELECT COUNT(*) AS n FROM projects WHERE id = ?', p.id)).toBe(1) // 未被删

    const anon = await ctx.app.inject({ method: 'DELETE', url: `/api/v1/projects/${p.id}` })
    expect(anon.statusCode).toBe(401)

    expect((await authed(ctx.app, cookie, 'DELETE', '/api/v1/projects/999999')).status).toBe(404)
  })

  it('S37-4: Agent delete_project——管理员 PAT 走通并落双层审计；成员 PAT 403', async () => {
    const p = await mkProject('Agent 硬删项目')
    const adminLogin = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/agent-login', payload: { username: 'admin', password: 'admin-pass-123' } })
    const adminToken = adminLogin.json().token

    const ok = await agent('POST', '/api/v1/agent/actions', { action: 'delete_project', params: { id: p.id } }, adminToken)
    expect(ok.status).toBe(200)
    expect(ok.body.ok).toBe(true)
    expect(count('SELECT COUNT(*) AS n FROM projects WHERE id = ?', p.id)).toBe(0)
    expect(ctx.db.prepare(`SELECT * FROM audit_logs WHERE action = 'agent.action.delete_project'`).get()).toBeTruthy()
    expect(ctx.db.prepare(`SELECT * FROM audit_logs WHERE action = 'project.hardDelete' AND object_id = ?`).get(String(p.id))).toBeTruthy()

    // 成员 PAT 403（adminOnly）
    const p2 = await mkProject('成员拒删项目')
    const mLogin = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/agent-login', payload: { username: 'zhangsan', password: 'pass-123456' } })
    const denied = await agent('POST', '/api/v1/agent/actions', { action: 'delete_project', params: { id: p2.id } }, mLogin.json().token)
    expect(denied.status).toBe(403)
    expect(count('SELECT COUNT(*) AS n FROM projects WHERE id = ?', p2.id)).toBe(1)
  })

  it('S37-1: 终态项目（已结项）同样可硬删', async () => {
    const cookie = await admin()
    const p = await mkProject('终态硬删项目')
    for (const t of p.tasks) {
      await authed(ctx.app, cookie, 'PATCH', `/api/v1/tasks/${t.id}`, { status: 'done' })
    }
    expect((await authed(ctx.app, cookie, 'POST', `/api/v1/projects/${p.id}/close`, { summary: '结项总结' })).status).toBe(200)
    expect((await authed(ctx.app, cookie, 'DELETE', `/api/v1/projects/${p.id}`)).status).toBe(200)
    expect(count('SELECT COUNT(*) AS n FROM projects WHERE id = ?', p.id)).toBe(0)
    expect(count('SELECT COUNT(*) AS n FROM tasks WHERE project_id = ?', p.id)).toBe(0)
  })
})
