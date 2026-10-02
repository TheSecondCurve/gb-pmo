import { describe, it, expect, afterAll } from 'vitest'
import { setupApp, loginCookie, authed } from './helpers.mjs'
import { dailyReport } from '../brain/report.js'
import { evaluateAlerts } from '../brain/alert.js'
import { personDigest } from '../brain/digest.js'
import { today } from '../db/time.js'

// PRD S23 — 任务参考资料（v0.13）：SOP/知识库链接手工维护（软删、结项只读）；
// 大脑推送给执行人（日报「我的任务」/逾期预警/个人梳理）正文附带标题+链接。

let ctx
afterAll(() => ctx?.db.close())

const dayOff = (n) => new Date(Date.parse(`${today()}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

async function admin() {
  return loginCookie(ctx.app, 'admin', 'admin-pass-123')
}

async function mkProject(name, leadId) {
  const res = await authed(ctx.app, await admin(), 'POST', '/api/v1/projects', {
    name, templateCode: 'software_delivery', leadMemberId: leadId, planEndDate: dayOff(30),
  })
  if (res.status !== 201) throw new Error(`mkProject failed: ${res.status} ${JSON.stringify(res.body)}`)
  return res.body
}

describe('S23 任务参考资料', () => {
  it('S23-1: 标题与 http(s) 链接必填（否则 400），添加后立即可见并留审计；编辑同校验', async () => {
    ctx = await setupApp()
    const cookie = await admin()
    const p = await mkProject('资料项目', ctx.members.lead.id)
    const taskId = p.tasks[0].id
    expect(p.tasks[0].refCount).toBe(0) // 项目详情任务行带参考资料计数（可见性）

    // 普通成员也可维护（D1 全员透明；走审计而非权限门槛）
    const zc = await loginCookie(ctx.app, 'lisi', 'pass-123456')
    const bad1 = await authed(ctx.app, cookie, 'POST', `/api/v1/tasks/${taskId}/refs`, { url: 'https://wiki.example.com/sop' })
    expect(bad1.status).toBe(400)
    const bad2 = await authed(ctx.app, cookie, 'POST', `/api/v1/tasks/${taskId}/refs`, { title: '部署 SOP', url: 'ftp://x' })
    expect(bad2.status).toBe(400)
    const bad3 = await authed(ctx.app, cookie, 'POST', '/api/v1/tasks/999/refs', { title: 'x', url: 'https://x.co' })
    expect(bad3.status).toBe(404)

    const ok = await authed(ctx.app, zc, 'POST', `/api/v1/tasks/${taskId}/refs`, {
      title: '部署 SOP', url: 'https://wiki.example.com/sop', note: '上线前必读',
    })
    expect(ok.status).toBe(201)
    expect(ok.body.ref.title).toBe('部署 SOP')
    expect(ok.body.ref.url).toBe('https://wiki.example.com/sop')
    expect(ok.body.ref.note).toBe('上线前必读')

    const list = await authed(ctx.app, zc, 'GET', `/api/v1/tasks/${taskId}/refs`)
    expect(list.body.refs.length).toBe(1)
    expect(ctx.db.prepare(`SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'task_ref.create'`).get().n).toBe(1)

    // 编辑：同校验（空标题/非 http(s) 拒绝；正常编辑生效留审计）
    expect((await authed(ctx.app, cookie, 'PATCH', `/api/v1/tasks/${taskId}/refs/${ok.body.ref.id}`, { title: ' ' })).status).toBe(400)
    expect((await authed(ctx.app, cookie, 'PATCH', `/api/v1/tasks/${taskId}/refs/${ok.body.ref.id}`, { url: 'not-a-url' })).status).toBe(400)
    const upd = await authed(ctx.app, cookie, 'PATCH', `/api/v1/tasks/${taskId}/refs/${ok.body.ref.id}`, { title: '部署 SOP v2' })
    expect(upd.body.ref.title).toBe('部署 SOP v2')
    expect(ctx.db.prepare(`SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'task_ref.update'`).get().n).toBe(1)
  })

  it('S23-2: 删除为软删（历史行保留、列表不再显示）；结项后任务面（含参考资料）只读 409', async () => {
    ctx = await setupApp()
    const cookie = await admin()
    const p = await mkProject('软删项目', ctx.members.lead.id)
    const taskId = p.tasks[0].id
    const ref = (await authed(ctx.app, cookie, 'POST', `/api/v1/tasks/${taskId}/refs`, { title: '知识库', url: 'https://kb.example.com' })).body.ref
    const ref2 = (await authed(ctx.app, cookie, 'POST', `/api/v1/tasks/${taskId}/refs`, { title: '回滚手册', url: 'https://kb.example.com/rollback' })).body.ref

    const del = await authed(ctx.app, cookie, 'DELETE', `/api/v1/tasks/${taskId}/refs/${ref.id}`)
    expect(del.status).toBe(200)
    const rows = ctx.db.prepare('SELECT * FROM task_refs WHERE id = ?').get(ref.id)
    expect(rows.deleted_at).toBeTruthy() // 行还在（软删）
    expect((await authed(ctx.app, cookie, 'GET', `/api/v1/tasks/${taskId}/refs`)).body.refs.map((r) => r.id)).toEqual([ref2.id])

    // 结项后任务面只读：模板任务全部标完成后走结项（S29：立项即进行中，无需再切状态）
    for (const t of p.tasks) await authed(ctx.app, cookie, 'PATCH', `/api/v1/tasks/${t.id}`, { status: 'done' })
    const closed = await authed(ctx.app, cookie, 'POST', `/api/v1/projects/${p.id}/close`, { summary: '交付完成' })
    expect(closed.status).toBe(200)
    expect((await authed(ctx.app, cookie, 'POST', `/api/v1/tasks/${taskId}/refs`, { title: 'x', url: 'https://x.co' })).status).toBe(409)
    expect((await authed(ctx.app, cookie, 'PATCH', `/api/v1/tasks/${taskId}/refs/${ref2.id}`, { title: 'y' })).status).toBe(409)
    expect((await authed(ctx.app, cookie, 'DELETE', `/api/v1/tasks/${taskId}/refs/${ref2.id}`)).status).toBe(409)
    expect((await authed(ctx.app, cookie, 'GET', `/api/v1/tasks/${taskId}/refs`)).status).toBe(200) // 只读可看
  })

  it('S23-3: 日报/逾期预警/个人梳理正文附带参考资料标题与链接；无资料任务不加空段落', async () => {
    ctx = await setupApp()
    const cookie = await admin()
    const p = await mkProject('推送附带项目', ctx.members.lead.id)
    const SOP = { title: '部署 SOP', url: 'https://wiki.example.com/deploy-sop' }

    // 任务 A：牵头人名下未完任务，挂参考资料 → 日报【我的任务】与个人梳理附带
    const taskA = p.tasks[0]
    await authed(ctx.app, cookie, 'POST', `/api/v1/tasks/${taskA.id}/refs`, SOP)
    // 任务 B：改派王五并置逾期，挂参考资料 → 逾期预警附带
    const taskB = p.tasks[1]
    await authed(ctx.app, cookie, 'PATCH', `/api/v1/tasks/${taskB.id}`, { responsibleMemberId: ctx.members.key.id, planEndDate: dayOff(-1) })
    await authed(ctx.app, cookie, 'POST', `/api/v1/tasks/${taskB.id}/refs`, { title: '验收清单', url: 'https://kb.example.com/accept' })

    // 日报：牵头人收到的正文含【参考资料】小节（标题+链接）；无资料成员不出现空段落
    await dailyReport(ctx.db, { force: true })
    const reportPush = ctx.db.prepare(`SELECT * FROM pushes WHERE push_type = 'daily_report' AND recipient_member_id = ?`).get(ctx.members.lead.id)
    expect(reportPush.body).toContain('【参考资料】')
    expect(reportPush.body).toContain(`${SOP.title} ${SOP.url}`)
    const plainPush = ctx.db.prepare(`SELECT * FROM pushes WHERE push_type = 'daily_report' AND recipient_member_id = ?`).get(ctx.members.dev.id)
    expect(plainPush.body).not.toContain('【参考资料】')

    // 逾期预警：任务行附带参考资料
    evaluateAlerts(ctx.db)
    const alertPush = ctx.db.prepare(`SELECT * FROM pushes WHERE push_type = 'alert' AND recipient_member_id = ? AND title LIKE '%逾期任务预警%'`).get(ctx.members.key.id)
    expect(alertPush.body).toContain(taskB.title)
    expect(alertPush.body).toContain(`验收清单 https://kb.example.com/accept`)

    // 个人梳理：任务行附带参考资料
    await personDigest(ctx.db, ctx.members.lead.id)
    const digestPush = ctx.db.prepare(`SELECT * FROM pushes WHERE push_type = 'digest' AND recipient_member_id = ?`).get(ctx.members.lead.id)
    expect(digestPush.body).toContain(taskA.title)
    expect(digestPush.body).toContain(`${SOP.title} ${SOP.url}`)
  })
})
