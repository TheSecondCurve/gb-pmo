import { describe, it, expect, afterAll } from 'vitest'
import { setupApp, loginCookie, authed } from './helpers.mjs'
import { confirmProposal } from '../engine/proposals.js'
import { runWriteTool } from '../brain/bot/tools.js'
import { buildSystemPrompt } from '../brain/bot/command.js'
import { queryMetric } from '../engine/metrics.js'

// PRD S38（v0.42）— 任务责任人可空·默认未指派：推翻 D3「默认责任人=牵头人」（design.md K20）。
// 一切建任务通道（web 逐条 / 立项实例化与自定义 / 提议 add_task）默认 NULL；
// 传入责任人补在职校验（原 FK-only 缺口）；未指派由 S2-1 清单 / unassigned_tasks 指标承载。

let ctx
afterAll(() => ctx?.db.close())

async function mkProject(cookie, name, extra = {}) {
  const res = await authed(ctx.app, cookie, 'POST', '/api/v1/projects', {
    name, templateCode: 'lianmai_365', leadMemberId: ctx.members.lead.id, ...extra,
  })
  return res
}

describe('S38 任务责任人可空·默认未指派', () => {
  it('S38-1: web 逐条新建未指定责任人 → NULL 不回填牵头人；显式指定按所给落库', async () => {
    ctx = await setupApp()
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const p = await mkProject(cookie, '客户S38甲系统')
    expect(p.status).toBe(201)

    const t = await authed(ctx.app, cookie, 'POST', '/api/v1/tasks', { projectId: p.body.id, title: '无责任人任务' })
    expect(t.status).toBe(201)
    expect(t.body.responsibleMemberId).toBeNull()

    const t2 = await authed(ctx.app, cookie, 'POST', '/api/v1/tasks', {
      projectId: p.body.id, title: '指定责任人任务', responsibleMemberId: ctx.members.dev.id,
    })
    expect(t2.status).toBe(201)
    expect(t2.body.responsibleMemberId).toBe(ctx.members.dev.id)
  })

  it('S38-2: 立项实例化（模板/自定义清单）责任人默认未指派；有计划开始日的进未指派清单与指标', async () => {
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const p = await mkProject(cookie, '客户S38乙系统')
    expect(p.status).toBe(201)
    expect(p.body.tasks.length).toBeGreaterThan(0)
    expect(p.body.tasks.every((t) => t.responsibleMemberId === null)).toBe(true)
    expect(p.body.tasks.every((t) => t.source === 'template')).toBe(true)

    // 自定义覆盖（S1-6）同口径：来源=手填，责任人同样默认未指派
    const custom = await mkProject(cookie, '客户S38丙系统', { tasks: ['现场调研', '割接上线'] })
    expect(custom.body.tasks.every((t) => t.responsibleMemberId === null && t.source === 'manual')).toBe(true)

    // 实例化任务落计划开始日（=立项日）→ 进 S2-1 未指派视图（初次分配工作队列）
    const un = await authed(ctx.app, cookie, 'GET', '/api/v1/tasks/unassigned')
    expect(un.body.tasks.some((t) => t.id === p.body.tasks[0].id)).toBe(true)
    // 指标口径同源（metrics.js 唯一真相源）
    const row = queryMetric(ctx.db, 'unassigned_tasks', { groupBy: 'project' }).rows.find((r) => r.project === '客户S38乙系统')
    expect(row?.count).toBe(p.body.tasks.length)
  })

  it('S38-3: 创建/改派传入不存在或已离职责任人 → 400；清空责任人（置 NULL）仍可用', async () => {
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const p = await mkProject(cookie, '客户S38丁系统')

    const bad = await authed(ctx.app, cookie, 'POST', '/api/v1/tasks', {
      projectId: p.body.id, title: '坏责任人任务', responsibleMemberId: 99999,
    })
    expect(bad.status).toBe(400)
    expect(bad.body.message).toContain('责任人不存在或已离职')

    // 已离职成员不可作责任人（与牵头人校验同口径）
    ctx.db.prepare(`UPDATE members SET status = 'offboarded', updated_at = ? WHERE id = ?`).run(Date.now(), ctx.members.key.id)
    const off = await authed(ctx.app, cookie, 'POST', '/api/v1/tasks', {
      projectId: p.body.id, title: '离职责任人任务', responsibleMemberId: ctx.members.key.id,
    })
    expect(off.status).toBe(400)
    expect(off.body.message).toContain('责任人不存在或已离职')

    // 改派：坏 id → 400；合法改派 → 生效；清空 → NULL
    const tid = p.body.tasks[0].id
    const badPatch = await authed(ctx.app, cookie, 'PATCH', `/api/v1/tasks/${tid}`, { responsibleMemberId: 99999 })
    expect(badPatch.status).toBe(400)
    const assign = await authed(ctx.app, cookie, 'PATCH', `/api/v1/tasks/${tid}`, { responsibleMemberId: ctx.members.dev.id })
    expect(assign.status).toBe(200)
    expect(assign.body.responsibleMemberId).toBe(ctx.members.dev.id)
    const clear = await authed(ctx.app, cookie, 'PATCH', `/api/v1/tasks/${tid}`, { responsibleMemberId: '' })
    expect(clear.status).toBe(200)
    expect(clear.body.responsibleMemberId).toBeNull()
  })

  it('S38-4: 机器人 add_task 提议未给责任人 → 确认生效默认未指派；摘要与协议提示词不再写「缺省=牵头人」', async () => {
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const p = await mkProject(cookie, '客户S38戊系统')

    const out = await runWriteTool(ctx.db, {
      kind: 'propose', payload: { kind: 'add_task', projectId: p.body.id, title: '口述无责任人任务' },
    }, { member: ctx.members.lead, evt: { ts: Date.now(), text: '建立任务：口述无责任人任务' } })
    expect(out.type).toBe('card')
    expect(out.summary).toContain('未指派')
    expect(out.summary).not.toContain('缺省牵头人')

    const conf = await confirmProposal(ctx.db, out.proposalId, ctx.members.lead.id)
    expect(conf.result.status).toBe('todo')
    expect(conf.result.responsibleMemberId).toBeNull()

    const sys = buildSystemPrompt(ctx.db, {
      member: ctx.members.lead, channel: { channel_type: 'dedicated', project_id: p.body.id }, chatType: 'group', surface: 'im',
    })
    expect(sys).not.toContain('缺省责任人=项目牵头人')
  })

  it('S38-5: 已指派任务清空责任人且有计划开始日 → 计入未指派视图（S2-1 兜底语义不变）', async () => {
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const p = await mkProject(cookie, '客户S38己系统')
    const tid = p.body.tasks[0].id
    await authed(ctx.app, cookie, 'PATCH', `/api/v1/tasks/${tid}`, { responsibleMemberId: ctx.members.dev.id })
    await authed(ctx.app, cookie, 'PATCH', `/api/v1/tasks/${tid}`, { responsibleMemberId: '' })
    const un = await authed(ctx.app, cookie, 'GET', '/api/v1/tasks/unassigned')
    expect(un.body.tasks.some((t) => t.id === tid)).toBe(true)
  })
})
