import { describe, it, expect, afterAll } from 'vitest'
import { setupApp, loginCookie, authed, waitFor } from './helpers.mjs'
import { createProposal, confirmProposal } from '../engine/proposals.js'
import { today, addDays } from '../db/time.js'

// PRD S39（v0.42）— 类型初始化提示词与 AI 初始分配：类型带 init_prompt（自然语言分配/倒排规则）；
// LLM 产「责任人+计划起止」批量草案（不落库，白名单校验+warnings）；web 人审后应用；
// Agent apply_init_assignments 可直写（信任边界限定例外，design.md K21）。
// v0.45（S44/K24）：草案请求异步化——本文件取草案一律经「启动 202 + 轮询」两段。

let ctx
afterAll(() => ctx?.db.close())

function fakeLlm(handler) {
  return { name: 'fake', complete: async (m) => handler(m) }
}

/** v0.45 异步草案：启动 → 轮询至终态，返回 done 载荷。 */
async function fetchDraft(cookie, projectId) {
  const started = await authed(ctx.app, cookie, 'POST', `/api/v1/projects/${projectId}/draft-init-assignments`, {})
  if (started.status !== 202) return started
  let last
  await waitFor(async () => {
    last = await authed(ctx.app, cookie, 'GET', `/api/v1/projects/${projectId}/draft-init-assignments/${started.body.draftId}`)
    return last.body.status !== 'running'
  }, { timeoutMs: 3000 })
  return last
}

async function mkType(cookie, { code, name, initPrompt, tasks = ['需求确认', '方案设计', '交付验收'] }) {
  const res = await authed(ctx.app, cookie, 'POST', '/api/v1/admin/project-types', { code, name, initPrompt, tasks })
  return res
}

async function mkProject(cookie, name, typeCode, extra = {}) {
  const res = await authed(ctx.app, cookie, 'POST', '/api/v1/projects', {
    name, typeCode, leadMemberId: ctx.members.lead.id, planEndDate: addDays(today(), 30), ...extra,
  })
  return res
}

describe('S39 类型初始化提示词与 AI 初始分配', () => {
  it('S39-1: 类型创建/编辑保存初始化提示词（空串归一 NULL）；超长/非字符串 400；回读一致', async () => {
    ctx = await setupApp()
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')

    const created = await mkType(cookie, { code: 'video_prod', name: '视频制作', initPrompt: '视频类任务归内容组；彩排安排在交付前 3 天' })
    expect(created.status).toBe(201)
    let types = (await authed(ctx.app, cookie, 'GET', '/api/v1/project-types')).body.types
    expect(types.find((t) => t.code === 'video_prod').initPrompt).toBe('视频类任务归内容组；彩排安排在交付前 3 天')

    // 编辑更新 + 空串归一 NULL
    const id = types.find((t) => t.code === 'video_prod').id
    const upd = await authed(ctx.app, cookie, 'PATCH', `/api/v1/admin/project-types/${id}`, { initPrompt: '新规则' })
    expect(upd.status).toBe(200)
    expect(upd.body.type.initPrompt).toBe('新规则')
    const cleared = await authed(ctx.app, cookie, 'PATCH', `/api/v1/admin/project-types/${id}`, { initPrompt: '' })
    expect(cleared.body.type.initPrompt).toBeNull()

    // 超长 / 非字符串 → 400
    expect((await authed(ctx.app, cookie, 'PATCH', `/api/v1/admin/project-types/${id}`, { initPrompt: 'x'.repeat(2001) })).status).toBe(400)
    expect((await authed(ctx.app, cookie, 'PATCH', `/api/v1/admin/project-types/${id}`, { initPrompt: 123 })).status).toBe(400)
    expect((await mkType(cookie, { code: 'bad_type', name: '坏类型', initPrompt: 42 })).status).toBe(400)
  })

  it('S39-2: 提议通道 create_project_type 携带 initPrompt，确认生效后落库', async () => {
    const prop = await createProposal(ctx.db, {
      kind: 'create_project_type',
      payload: { code: 'event_ops', name: '活动运营', initPrompt: '搭建类任务归交付部', tasks: ['场地搭建', '现场执行'] },
      summary: '新建项目类型「活动运营」', proposedBy: ctx.members.admin.id,
    })
    const conf = await confirmProposal(ctx.db, prop.id, ctx.members.admin.id)
    expect(conf.result.initPrompt).toBe('搭建类任务归交付部')
    const row = ctx.db.prepare(`SELECT init_prompt FROM project_types WHERE code = 'event_ops'`).get()
    expect(row.init_prompt).toBe('搭建类任务归交付部')
  })

  it('S39-3: LLM 未配置请求草案 → 503 给配置指引（不降级瞎生成）', async () => {
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    await mkType(cookie, { code: 'consult_x', name: '咨询X' })
    const p = await mkProject(cookie, '客户S39甲', 'consult_x')
    const res = await authed(ctx.app, cookie, 'POST', `/api/v1/projects/${p.body.id}/draft-init-assignments`, {})
    expect(res.status).toBe(503)
    expect(JSON.stringify(res.body)).toMatch(/LLM 未配置/)
  })

  it('S39-4: 草案白名单校验——非法任务/成员/日期过滤进 warnings；遗漏任务补保持现状行；草案不落库', async () => {
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    await mkType(cookie, { code: 'video_prod2', name: '视频制作2', initPrompt: '专属规则：归内容组' })
    const p = await mkProject(cookie, '客户S39乙', 'video_prod2')
    const tasks = p.body.tasks // 3 条：需求确认/方案设计/交付验收
    expect(tasks.length).toBe(3)

    let seenMessages = null
    ctx.app.llm = fakeLlm((m) => {
      seenMessages = m
      return JSON.stringify({
        assignments: [
          { taskId: tasks[0].id, responsibleMemberId: ctx.members.dev.id, planStartDate: today(), planEndDate: addDays(today(), 5) },
          { taskId: 999999, responsibleMemberId: ctx.members.dev.id }, // 非本项目任务
          { taskId: tasks[1].id, responsibleMemberId: 88888 }, // 不存在成员
          { taskId: tasks[1].id, responsibleMemberId: ctx.members.dev.id, planStartDate: '2026-13-40' }, // 非法日期
          { taskId: tasks[1].id, planStartDate: addDays(today(), 10), planEndDate: addDays(today(), 5) }, // 止早于起
          // tasks[2] 被 LLM 遗漏
        ],
      })
    })
    const res = await fetchDraft(cookie, p.body.id) // v0.45：202 启动 + 轮询取 done
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('done')
    // 类型提示词进了 LLM 上下文
    expect(JSON.stringify(seenMessages)).toContain('专属规则：归内容组')
    // 草案 = 全任务覆盖的完整目标状态：3 行（遗漏任务补保持现状）
    expect(res.body.assignments).toHaveLength(3)
    const a0 = res.body.assignments.find((a) => a.taskId === tasks[0].id)
    expect(a0.responsibleMemberId).toBe(ctx.members.dev.id)
    expect(a0.planEndDate).toBe(addDays(today(), 5))
    const a2 = res.body.assignments.find((a) => a.taskId === tasks[2].id)
    expect(a2.responsibleMemberId).toBeNull() // 保持现状（当前即未指派）
    // 4 行非法行进 warnings
    expect(res.body.warnings.length).toBe(4)
    // 草案不落库：任务仍全部未指派、无 task.initAssign 审计
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND responsible_member_id IS NOT NULL').get(p.body.id).n).toBe(0)
    expect(ctx.db.prepare(`SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'task.initAssign'`).get().n).toBe(0)
  })

  it('S39-5: 应用批量分配——单事务生效+留痕；非法行 400 且全部不落库；空清单 400', async () => {
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const p = await mkProject(cookie, '客户S39丙', 'consult_x')
    const [t0, t1] = p.body.tasks
    const rows = [
      { taskId: t0.id, responsibleMemberId: ctx.members.dev.id, planStartDate: today(), planEndDate: addDays(today(), 7) },
      { taskId: t1.id, responsibleMemberId: ctx.members.key.id, planStartDate: addDays(today(), 8), planEndDate: addDays(today(), 20) },
    ]
    const ok = await authed(ctx.app, cookie, 'POST', `/api/v1/projects/${p.body.id}/init-assignments`, { assignments: rows })
    expect(ok.status).toBe(200)
    expect(ok.body.updated).toBe(2)
    const r0 = ctx.db.prepare('SELECT responsible_member_id AS o, plan_end_date AS e FROM tasks WHERE id = ?').get(t0.id)
    expect([r0.o, r0.e]).toEqual([ctx.members.dev.id, addDays(today(), 7)])
    // 留痕：一条讨论面记录事件 + 一条 task.initAssign 审计（含 payload 快照）
    const evt = ctx.db.prepare(`SELECT * FROM project_events WHERE project_id = ? AND summary LIKE '%初始化分配%'`).get(p.body.id)
    expect(evt).toBeTruthy()
    const auditRow = ctx.db.prepare(`SELECT * FROM audit_logs WHERE action = 'task.initAssign'`).get()
    expect(auditRow).toBeTruthy()
    expect(auditRow.detail).toContain(String(t0.id))

    // 非法行（别的项目任务）→ 400 且同事务回滚：同批合法行也不落库
    const other = await mkProject(cookie, '客户S39丁', 'consult_x')
    const before = ctx.db.prepare('SELECT responsible_member_id AS o FROM tasks WHERE id = ?').get(p.body.tasks[2].id).o
    const bad = await authed(ctx.app, cookie, 'POST', `/api/v1/projects/${p.body.id}/init-assignments`, {
      assignments: [
        { taskId: p.body.tasks[2].id, responsibleMemberId: ctx.members.dev.id },
        { taskId: other.body.tasks[0].id, responsibleMemberId: ctx.members.dev.id },
      ],
    })
    expect(bad.status).toBe(400)
    expect(ctx.db.prepare('SELECT responsible_member_id AS o FROM tasks WHERE id = ?').get(p.body.tasks[2].id).o).toBe(before)

    expect((await authed(ctx.app, cookie, 'POST', `/api/v1/projects/${p.body.id}/init-assignments`, { assignments: [] })).status).toBe(400)
    expect((await authed(ctx.app, cookie, 'POST', `/api/v1/projects/${p.body.id}/init-assignments`, {
      assignments: [{ taskId: t0.id, responsibleMemberId: 99999 }],
    })).status).toBe(400)
    expect((await authed(ctx.app, cookie, 'POST', `/api/v1/projects/${p.body.id}/init-assignments`, {
      assignments: [{ taskId: t0.id, planStartDate: addDays(today(), 9), planEndDate: addDays(today(), 1) }],
    })).status).toBe(400)
  })

  it('S39-6: Agent action 通道——write scope 可用并落审计；read scope 403', async () => {
    // write PAT（成员 zhangsan）
    const login = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/agent-login', payload: { username: 'zhangsan', password: 'pass-123456' } })
    const writeToken = login.json().token
    const cookie = await loginCookie(ctx.app, 'zhangsan', 'pass-123456')
    const readRes = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/tokens', payload: { scope: 'read' }, headers: { cookie } })
    const readToken = readRes.json().token
    const agent = (payload, token) => ctx.app.inject({
      method: 'POST', url: '/api/v1/agent/actions', payload, headers: { authorization: `Bearer ${token}` },
    }).then((r) => ({ status: r.statusCode, body: r.json() }))

    const p = await mkProject(await loginCookie(ctx.app, 'admin', 'admin-pass-123'), '客户S39戊', 'consult_x')
    ctx.app.llm = fakeLlm(() => JSON.stringify({
      assignments: p.body.tasks.map((t) => ({ taskId: t.id, responsibleMemberId: ctx.members.dev.id })),
    }))

    const denied = await agent({ action: 'draft_init_assignments', params: { projectId: p.body.id } }, readToken)
    expect(denied.status).toBe(403)
    const draft = await agent({ action: 'draft_init_assignments', params: { projectId: p.body.id } }, writeToken)
    expect(draft.status).toBe(200)
    // v0.45（S44）：action 返回 draftId，经 Agent 侧 GET 轮询取 done 载荷
    const { draftId } = draft.body.result
    let polled
    await waitFor(async () => {
      const res = await ctx.app.inject({
        method: 'GET', url: `/api/v1/agent/draft-init-assignments/${draftId}?projectId=${p.body.id}`,
        headers: { authorization: `Bearer ${readToken}` },
      })
      polled = res.json()
      return polled.status !== 'running'
    }, { timeoutMs: 3000 })
    expect(polled.status).toBe('done')
    expect(polled.assignments).toHaveLength(p.body.tasks.length)

    const deniedApply = await agent({ action: 'apply_init_assignments', params: { projectId: p.body.id, assignments: [] } }, readToken)
    expect(deniedApply.status).toBe(403)
    const applied = await agent({
      action: 'apply_init_assignments',
      params: { projectId: p.body.id, assignments: polled.assignments },
    }, writeToken)
    expect(applied.status).toBe(200)
    expect(applied.body.result.updated).toBe(p.body.tasks.length)
    expect(ctx.db.prepare(`SELECT * FROM audit_logs WHERE action = 'agent.action.apply_init_assignments'`).get()).toBeTruthy()
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND responsible_member_id = ?').get(p.body.id, ctx.members.dev.id).n).toBe(p.body.tasks.length)
  })

  it('S39-7: 终态项目草案与应用均 409；项目不存在 404', async () => {
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const p = await mkProject(cookie, '客户S39己', 'consult_x')
    for (const t of p.body.tasks) await authed(ctx.app, cookie, 'PATCH', `/api/v1/tasks/${t.id}`, { status: 'done' })
    await authed(ctx.app, cookie, 'POST', `/api/v1/projects/${p.body.id}/close`, { summary: '交付完成' })

    ctx.app.llm = fakeLlm(() => JSON.stringify({ assignments: [] }))
    expect((await authed(ctx.app, cookie, 'POST', `/api/v1/projects/${p.body.id}/draft-init-assignments`, {})).status).toBe(409)
    expect((await authed(ctx.app, cookie, 'POST', `/api/v1/projects/${p.body.id}/init-assignments`, {
      assignments: [{ taskId: p.body.tasks[0].id, responsibleMemberId: ctx.members.dev.id }],
    })).status).toBe(409)
    expect((await authed(ctx.app, cookie, 'POST', '/api/v1/projects/99999/draft-init-assignments', {})).status).toBe(404)
    expect((await authed(ctx.app, cookie, 'POST', '/api/v1/projects/99999/init-assignments', { assignments: [] })).status).toBe(404)
    // 未登录 401
    expect((await ctx.app.inject({ method: 'POST', url: `/api/v1/projects/${p.body.id}/init-assignments`, payload: { assignments: [] } })).statusCode).toBe(401)
  })
})
