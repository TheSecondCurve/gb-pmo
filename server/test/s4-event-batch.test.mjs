import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupApp, loginCookie, authed } from './helpers.mjs'
import { addEvent, confirmEvents, rejectEvents } from '../engine/events.js'
import { updateTask } from '../engine/tasks.js'
import { closeProject } from '../engine/projects.js'

// PRD S4-7（v0.46/K25）— 待确认建议一键批量处理：confirmEvent/rejectEvent 同口子逐条应用，
// 单条失败（409）不阻塞其余，聚合回执生效/驳回计数与失败明细。抽取面信任边界不变（建议仍 pending 等人确认）。

let ctx
beforeAll(async () => {
  ctx = await setupApp()
})
afterAll(() => ctx?.db.close())

async function mkProject(name) {
  const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
  const res = await authed(ctx.app, cookie, 'POST', '/api/v1/projects', {
    name, templateCode: 'lianmai_365', leadMemberId: ctx.members.lead.id, planEndDate: '2026-12-31',
  })
  return res.body
}

/** 造一条抽取面 pending 建议（target=任务状态→done）。 */
function mkPendingSuggestion(projectId, taskId) {
  return addEvent(ctx.db, {
    projectId, eventType: 'status_change', nature: 'suggestion',
    summary: `任务 #${taskId} 状态 → 已完成`, sourcePlatform: 'feishu', generatedBy: 'extraction',
    targetTaskId: taskId, targetField: 'status', targetValue: 'done',
  })
}

describe('S4-7 待确认建议一键批量处理', () => {
  it('批量生效：多条 pending 建议逐条走 confirmEvent 生效并留痕（decided_by=操作人）', async () => {
    const p = await mkProject('批量项目A')
    const tasks = ctx.db.prepare('SELECT id FROM tasks WHERE project_id = ? ORDER BY id LIMIT 3').all(p.id)
    const evts = tasks.map((t) => mkPendingSuggestion(p.id, t.id))

    const cookie = await loginCookie(ctx.app, 'zhangsan', 'pass-123456')
    const res = await authed(ctx.app, cookie, 'POST', '/api/v1/events/confirm-batch', { ids: evts.map((e) => e.id) })
    expect(res.status).toBe(200)
    expect(res.body.confirmed).toHaveLength(3)
    expect(res.body.failed).toHaveLength(0)
    for (const t of tasks) {
      expect(ctx.db.prepare('SELECT status FROM tasks WHERE id = ?').get(t.id).status).toBe('done')
    }
    const rows = ctx.db.prepare(`SELECT id, status, decided_by FROM project_events WHERE id IN (${evts.map((e) => e.id).join(',')})`).all()
    expect(rows.every((r) => r.status === 'effective' && r.decided_by === ctx.members.lead.id)).toBe(true)
  })

  it('批量驳回：逐条 rejectEvent，聚合回执', async () => {
    const p = await mkProject('批量项目B')
    const tasks = ctx.db.prepare('SELECT id FROM tasks WHERE project_id = ? ORDER BY id LIMIT 2').all(p.id)
    const evts = tasks.map((t) => mkPendingSuggestion(p.id, t.id))

    const cookie = await loginCookie(ctx.app, 'zhangsan', 'pass-123456')
    const res = await authed(ctx.app, cookie, 'POST', '/api/v1/events/reject-batch', { ids: evts.map((e) => e.id) })
    expect(res.status).toBe(200)
    expect(res.body.rejected).toHaveLength(2)
    expect(ctx.db.prepare(`SELECT COUNT(*) AS n FROM project_events WHERE status = 'rejected' AND project_id = ?`).get(p.id).n).toBe(2)
    // 驳回不改任务面
    expect(ctx.db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND status = 'done'`).get(p.id).n).toBe(0)
  })

  it('单条失败不阻塞其余：已确认/不存在/终态项目的 id 计入失败明细，聚合 200 返回', async () => {
    const p = await mkProject('批量项目C')
    const [t1, t2] = ctx.db.prepare('SELECT id FROM tasks WHERE project_id = ? ORDER BY id LIMIT 2').all(p.id).map((r) => r.id)
    const okEvt = mkPendingSuggestion(p.id, t1)
    const doneEvt = mkPendingSuggestion(p.id, t2)
    // 预置一条已生效（重复确认 → 409）与一个不存在的 id
    ctx.db.prepare(`UPDATE project_events SET status = 'effective' WHERE id = ?`).run(doneEvt.id)

    // 另一个项目终态化后其 pending 建议确认被拒（S29 终态只读）
    const p2 = await mkProject('批量项目D')
    const t3 = ctx.db.prepare('SELECT id FROM tasks WHERE project_id = ? ORDER BY id LIMIT 1').get(p2.id).id
    const closedEvt = mkPendingSuggestion(p2.id, t3)
    for (const t of ctx.db.prepare('SELECT id FROM tasks WHERE project_id = ?').all(p2.id)) updateTask(ctx.db, t.id, { status: 'done' }, 1)
    closeProject(ctx.db, p2.id, { summary: '收尾' }, 1)

    const cookie = await loginCookie(ctx.app, 'zhangsan', 'pass-123456')
    const res = await authed(ctx.app, cookie, 'POST', '/api/v1/events/confirm-batch', { ids: [okEvt.id, doneEvt.id, 999999, closedEvt.id] })
    expect(res.status).toBe(200)
    expect(res.body.confirmed).toEqual([okEvt.id])
    expect(res.body.failed).toHaveLength(3)
    expect(res.body.failed.map((f) => f.id)).toEqual(expect.arrayContaining([doneEvt.id, 999999, closedEvt.id]))
    expect(res.body.failed.every((f) => typeof f.message === 'string' && f.message.length > 0)).toBe(true)
    // 唯一应生效的任务已改，其余不动
    expect(ctx.db.prepare('SELECT status FROM tasks WHERE id = ?').get(t1).status).toBe('done')
    expect(ctx.db.prepare('SELECT status FROM tasks WHERE id = ?').get(t2).status).not.toBe('done')
  })

  it('参数校验：空数组/非数组/非法 id 400；未登录 401', async () => {
    const cookie = await loginCookie(ctx.app, 'zhangsan', 'pass-123456')
    const empty = await authed(ctx.app, cookie, 'POST', '/api/v1/events/confirm-batch', { ids: [] })
    expect(empty.status).toBe(400)
    const notArray = await authed(ctx.app, cookie, 'POST', '/api/v1/events/confirm-batch', { ids: 'x' })
    expect(notArray.status).toBe(400)
    const badId = await authed(ctx.app, cookie, 'POST', '/api/v1/events/reject-batch', { ids: ['abc'] })
    expect(badId.status).toBe(400)
    const anon = await ctx.app.inject({ method: 'POST', url: '/api/v1/events/confirm-batch', payload: { ids: [1] } })
    expect(anon.statusCode).toBe(401)
  })

  it('engine 层：confirmEvents/rejectEvents 聚合语义（空输入 400，部分失败聚合）', async () => {
    const p = await mkProject('批量项目E')
    const t1 = ctx.db.prepare('SELECT id FROM tasks WHERE project_id = ? ORDER BY id LIMIT 1').get(p.id).id
    const e1 = mkPendingSuggestion(p.id, t1)
    expect(() => confirmEvents(ctx.db, [], 1)).toThrow(/ids/)
    const r = confirmEvents(ctx.db, [e1.id, 999998], ctx.members.lead.id)
    expect(r.confirmed).toEqual([e1.id])
    expect(r.failed).toHaveLength(1)
    expect(r.failed[0].id).toBe(999998)
    const rj = rejectEvents(ctx.db, [999997], ctx.members.lead.id)
    expect(rj.rejected).toHaveLength(0)
    expect(rj.failed[0].id).toBe(999997)
  })
})
