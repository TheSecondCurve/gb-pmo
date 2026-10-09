import { describe, it, expect, afterAll } from 'vitest'
import { setupApp, loginCookie, authed, waitFor } from './helpers.mjs'
import { today, addDays } from '../db/time.js'

// PRD S44（v0.45）— AI 初始分配草案异步化（design.md K24）：启动同步校验后 202 返回 draftId，
// LLM 进程内后台执行；轮询 running/done/error（错误也 200 载荷返回，规避 PaaS 网关 5xx 替换）。
// 线上实证：Zeabur 前 Cloudflare 边缘 ~120s 即 524，GLM 大 JSON 稳态要约 2 分钟。

let ctx
afterAll(() => ctx?.db.close())

const VALID_JSON = (tasks) => JSON.stringify({
  assignments: tasks.map((t) => ({ taskId: t.id, responsibleMemberId: ctx.members.dev.id, planStartDate: today(), planEndDate: addDays(today(), 5) })),
})

async function mkProject(cookie, name) {
  const res = await authed(ctx.app, cookie, 'POST', '/api/v1/projects', {
    name, templateCode: 'consulting_1v1', leadMemberId: ctx.members.lead.id, planEndDate: addDays(today(), 30),
  })
  return res.body
}

async function pollWeb(cookie, projectId, draftId) {
  let last
  await waitFor(async () => {
    last = await authed(ctx.app, cookie, 'GET', `/api/v1/projects/${projectId}/draft-init-assignments/${draftId}`)
    return last.body.status !== 'running'
  }, { timeoutMs: 3000 })
  return last
}

describe('S44 草案请求异步化', () => {
  it('S44-1: 启动同步校验（404/409/503）后立即 202 返回 draftId + running', async () => {
    ctx = await setupApp()
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const p = await mkProject(cookie, '异步甲项目')

    // 无 LLM → 503 指引（同步，与 v0.42 语义一致）
    const noLlm = await authed(ctx.app, cookie, 'POST', `/api/v1/projects/${p.id}/draft-init-assignments`, {})
    expect(noLlm.status).toBe(503)
    expect(JSON.stringify(noLlm.body)).toMatch(/LLM 未配置/)

    ctx.app.llm = { name: 'fake', complete: async () => VALID_JSON(p.tasks) }
    const started = await authed(ctx.app, cookie, 'POST', `/api/v1/projects/${p.id}/draft-init-assignments`, {})
    expect(started.status).toBe(202)
    expect(started.body.status).toBe('running')
    expect(typeof started.body.draftId).toBe('string')

    // 项目不存在 404（同步）
    expect((await authed(ctx.app, cookie, 'POST', '/api/v1/projects/99999/draft-init-assignments', {})).status).toBe(404)

    // 终态 409（同步）：结项后再启动
    const p2 = await mkProject(cookie, '异步乙项目')
    for (const t of p2.tasks) await authed(ctx.app, cookie, 'PATCH', `/api/v1/tasks/${t.id}`, { status: 'done' })
    await authed(ctx.app, cookie, 'POST', `/api/v1/projects/${p2.id}/close`, { summary: '交付完成' })
    expect((await authed(ctx.app, cookie, 'POST', `/api/v1/projects/${p2.id}/draft-init-assignments`, {})).status).toBe(409)
  })

  it('S44-2: 轮询 running（含 elapsedMs）→ done（assignments/warnings）；他项目/不存在 draftId 404', async () => {
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const p = await mkProject(cookie, '异步丙项目')

    // 可控释放的 LLM：保证能观测到 running 态
    let release
    ctx.app.llm = { name: 'fake', complete: () => new Promise((r) => { release = () => r(VALID_JSON(p.tasks)) }) }
    const started = await authed(ctx.app, cookie, 'POST', `/api/v1/projects/${p.id}/draft-init-assignments`, {})
    expect(started.status).toBe(202)
    const { draftId } = started.body

    const running = await authed(ctx.app, cookie, 'GET', `/api/v1/projects/${p.id}/draft-init-assignments/${draftId}`)
    expect(running.status).toBe(200)
    expect(running.body.status).toBe('running')
    expect(running.body.elapsedMs).toBeGreaterThanOrEqual(0)

    release()
    const done = await pollWeb(cookie, p.id, draftId)
    expect(done.status).toBe(200)
    expect(done.body.status).toBe('done')
    expect(done.body.assignments).toHaveLength(p.tasks.length)
    expect(done.body.warnings).toEqual([])
    expect(done.body.assignments[0].responsibleMemberId).toBe(ctx.members.dev.id)

    // draftId 不存在 → 404；他项目 id 访问 → 404（不泄漏作业存在性）
    expect((await authed(ctx.app, cookie, 'GET', `/api/v1/projects/${p.id}/draft-init-assignments/nope`)).status).toBe(404)
    const other = await mkProject(cookie, '异步丁项目')
    expect((await authed(ctx.app, cookie, 'GET', `/api/v1/projects/${other.id}/draft-init-assignments/${draftId}`)).status).toBe(404)
  })

  it('S44-3: 后台 LLM 失败 → 轮询 HTTP 200 {status:error, message 中文}，不暴露英文原文', async () => {
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const p = await mkProject(cookie, '异步戊项目')
    ctx.app.llm = {
      name: 'fake',
      complete: async () => {
        throw Object.assign(new Error('LLM 响应超时（已自动重试一次，每次上限 120000ms）：上游未在限时内返回完整结果——可稍后重试，或在配置台「外部依赖 → LLM」调大超时'), { statusCode: 504 })
      },
    }
    const started = await authed(ctx.app, cookie, 'POST', `/api/v1/projects/${p.id}/draft-init-assignments`, {})
    expect(started.status).toBe(202)
    const out = await pollWeb(cookie, p.id, started.body.draftId)
    expect(out.status).toBe(200) // 错误以 200 载荷返回（规避网关 5xx 替换）
    expect(out.body.status).toBe('error')
    expect(out.body.message).toContain('超时')
    expect(out.body.message).not.toContain('AbortError')
  })

  it('S44-4: Agent action 返回 draftId；Agent 侧 GET 轮询（read scope 即可）拿到同一作业结果', async () => {
    const login = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/agent-login', payload: { username: 'zhangsan', password: 'pass-123456' } })
    const writeToken = login.json().token
    const cookieZ = await loginCookie(ctx.app, 'zhangsan', 'pass-123456')
    const readRes = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/tokens', payload: { scope: 'read' }, headers: { cookie: cookieZ } })
    const readToken = readRes.json().token

    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const p = await mkProject(cookie, '异步己项目')
    ctx.app.llm = { name: 'fake', complete: async () => VALID_JSON(p.tasks) }

    const started = await ctx.app.inject({
      method: 'POST', url: '/api/v1/agent/actions',
      payload: { action: 'draft_init_assignments', params: { projectId: p.id } },
      headers: { authorization: `Bearer ${writeToken}` },
    })
    expect(started.statusCode).toBe(200)
    const { draftId, status } = started.json().result
    expect(status).toBe('running')
    expect(typeof draftId).toBe('string')

    // read scope PAT 轮询 Agent 侧 GET → 终态 done
    let last
    await waitFor(async () => {
      const res = await ctx.app.inject({
        method: 'GET', url: `/api/v1/agent/draft-init-assignments/${draftId}?projectId=${p.id}`,
        headers: { authorization: `Bearer ${readToken}` },
      })
      last = { status: res.statusCode, body: res.json() }
      return last.body.status !== 'running'
    }, { timeoutMs: 3000 })
    expect(last.status).toBe(200)
    expect(last.body.status).toBe('done')
    expect(last.body.assignments).toHaveLength(p.tasks.length)
  })
})
