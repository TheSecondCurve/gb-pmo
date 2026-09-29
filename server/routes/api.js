// 业务路由：参数校验 + 权限校验 + 调 engine（不写业务 SQL）
import * as members from '../engine/members.js'
import * as projects from '../engine/projects.js'
import * as tasks from '../engine/tasks.js'
import * as events from '../engine/events.js'
import * as auth from '../engine/auth.js'
import { getAllSettings, setSetting, getSetting } from '../engine/settings.js'
import { queryMetric, listMetrics } from '../engine/metrics.js'
import { assertValue } from '../engine/enums.js'

export function registerApiRoutes(app) {
  const db = app.db

  const requireAdmin = (req, reply) => {
    if (req.member?.role !== 'admin') {
      reply.status(403).send({ message: '需要管理员权限' })
      return false
    }
    return true
  }

  // —— 认证 ——

  app.post('/api/v1/auth/login', async (req, reply) => {
    const { member, sid } = auth.login(db, req.body?.username, req.body?.password)
    reply.setCookie('pmo_session', sid, {
      httpOnly: true, sameSite: 'lax', path: '/', signed: true,
    })
    return { member }
  })

  app.post('/api/v1/auth/logout', async (req, reply) => {
    const raw = req.cookies['pmo_session']
    const uns = raw ? app.unsignCookie(raw) : null
    if (uns?.valid) auth.destroySession(db, uns.value)
    reply.clearCookie('pmo_session', { path: '/' })
    return { ok: true }
  })

  app.get('/api/v1/auth/me', async (req) => ({ member: req.member }))

  app.get('/api/v1/auth/tokens', async (req) => ({ tokens: auth.listTokens(db, req.member.id) }))

  app.post('/api/v1/auth/tokens', async (req) => {
    const scope = assertValue('tokenScope', req.body?.scope || 'read')
    const out = auth.issueToken(db, req.member.id, { scope, name: req.body?.name || 'agent' })
    auth.audit(db, { memberId: req.member.id, action: 'token.issue', objectType: 'token', objectId: out.id, detail: { scope } })
    return out
  })

  app.delete('/api/v1/auth/tokens/:id', async (req, reply) => {
    const id = Number(req.params.id)
    const list = auth.listTokens(db, req.member.id)
    if (!list.some((t) => t.id === id)) return reply.status(404).send({ message: '令牌不存在或不属于你' })
    auth.revokeToken(db, id, req.member.id)
    return { ok: true }
  })

  // —— 成员（D1 全员透明：查看全员可；维护管理员）——

  app.get('/api/v1/members', async () => ({ members: members.listMembers(db) }))

  app.post('/api/v1/members', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    return reply.status(201).send({ member: members.createMember(db, req.body, req.member.id) })
  })

  app.patch('/api/v1/members/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    return { member: members.updateMember(db, Number(req.params.id), req.body, req.member.id) }
  })

  app.post('/api/v1/members/:id/offboard', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    return { member: members.offboardMember(db, Number(req.params.id), req.body?.handover || {}, req.member.id) }
  })

  // —— 项目 ——

  app.get('/api/v1/projects', async (req) => {
    const statuses = req.query.status ? String(req.query.status).split(',') : undefined
    return { projects: projects.listProjects(db, { statuses }) }
  })

  app.post('/api/v1/projects', async (req, reply) => {
    return reply.status(201).send(projects.createProject(db, req.body, req.member.id))
  })

  app.get('/api/v1/projects/:id', async (req) => projects.getProjectDetail(db, Number(req.params.id)))

  app.patch('/api/v1/projects/:id', async (req) => projects.updateProject(db, Number(req.params.id), req.body, req.member.id))

  app.post('/api/v1/projects/:id/stages', async (req, reply) => {
    return reply.status(201).send(projects.addStage(db, Number(req.params.id), req.body?.name))
  })

  app.post('/api/v1/projects/:id/close', async (req) => {
    // S8-2：未提供摘要时由大脑基于事件流自动生成（LLM 可用则归纳，人工可改）
    let summary = req.body?.summary
    if (!summary) {
      const { closeoutSummary } = await import('../brain/digest.js')
      summary = await closeoutSummary(db, Number(req.params.id))
    }
    return projects.closeProject(db, Number(req.params.id), { summary, dispositions: req.body?.dispositions || [] }, req.member.id)
  })

  app.get('/api/v1/projects/:id/events', async (req) =>
    ({ events: events.listEvents(db, { projectId: Number(req.params.id), status: req.query.status }) })
  )

  app.post('/api/v1/projects/:id/events', async (req, reply) => {
    return reply.status(201).send(
      events.addEvent(db, {
        ...req.body, projectId: Number(req.params.id),
        sourcePlatform: 'web', generatedBy: 'web', speakerMemberId: req.member.id,
      })
    )
  })

  // —— 任务 / 里程碑 / 依赖 / 渠道 ——

  app.get('/api/v1/tasks', async (req) => {
    const q = req.query
    return {
      tasks: tasks.listTasks(db, {
        projectId: q.projectId ? Number(q.projectId) : undefined,
        responsibleMemberId: q.responsibleMemberId ? Number(q.responsibleMemberId) : undefined,
        statuses: q.status ? String(q.status).split(',') : undefined,
      }),
    }
  })

  app.get('/api/v1/tasks/unassigned', async () => ({ tasks: tasks.listUnassigned(db) }))

  app.post('/api/v1/tasks', async (req, reply) => {
    return reply.status(201).send(tasks.createTask(db, req.body, req.member.id))
  })

  app.patch('/api/v1/tasks/:id', async (req) => tasks.updateTask(db, Number(req.params.id), req.body, req.member.id))

  app.post('/api/v1/milestones', async (req, reply) => {
    return reply.status(201).send(tasks.createMilestone(db, req.body, req.member.id))
  })

  app.patch('/api/v1/milestones/:id', async (req) => tasks.updateMilestone(db, Number(req.params.id), req.body, req.member.id))

  app.post('/api/v1/dependencies', async (req, reply) => {
    return reply.status(201).send(tasks.createDependency(db, req.body, req.member.id))
  })

  app.post('/api/v1/dependencies/evaluate', async (req) => ({ updated: tasks.evaluateDependencyStatus(db) }))

  app.get('/api/v1/channels', async () => ({ channels: tasks.listChannels(db) }))

  app.post('/api/v1/channels', async (req, reply) => {
    return reply.status(201).send(tasks.upsertChannel(db, req.body, req.member.id))
  })

  app.delete('/api/v1/channels/:id', async (req) => {
    tasks.deleteChannel(db, Number(req.params.id), req.member.id)
    return { ok: true }
  })

  // —— 事件确认流 ——

  app.get('/api/v1/events', async (req) => {
    const q = req.query
    return {
      events: events.listEvents(db, {
        projectId: q.projectId ? Number(q.projectId) : undefined,
        status: q.status,
      }),
    }
  })

  app.get('/api/v1/events/pending', async (req) => ({ events: events.pendingSuggestionsFor(db, req.member.id) }))

  app.post('/api/v1/events', async (req, reply) => {
    return reply.status(201).send(
      events.addEvent(db, { ...req.body, sourcePlatform: 'web', generatedBy: 'web', speakerMemberId: req.member.id })
    )
  })

  app.post('/api/v1/events/:id/confirm', async (req) => events.confirmEvent(db, Number(req.params.id), req.member.id))
  app.post('/api/v1/events/:id/reject', async (req) => events.rejectEvent(db, Number(req.params.id), req.member.id))

  // —— 指标（dashboard 取数唯一入口）——

  app.get('/api/v1/metrics', async () => ({ metrics: listMetrics() }))
  app.get('/api/v1/metrics/:id/query', async (req) => queryMetric(db, req.params.id, req.query))

  // —— 大脑触发（web 入口；Agent 走 action 端点，同一实现）——

  app.post('/api/v1/projects/:id/digest', async (req) => {
    const { projectDigest } = await import('../brain/digest.js')
    return projectDigest(db, Number(req.params.id), { llm: app.llm ?? undefined })
  })

  app.post('/api/v1/members/:id/digest', async (req, reply) => {
    const id = Number(req.params.id)
    if (id !== req.member.id && req.member.role !== 'admin') {
      return reply.status(403).send({ message: '只能生成自己的梳理（或管理员）' })
    }
    const { personDigest } = await import('../brain/digest.js')
    return personDigest(db, id, { llm: app.llm ?? undefined })
  })

  // —— 管理员：待办 / 配置 / 连通性测试 / 令牌治理 ——

  app.get('/api/v1/admin/todo', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    return { projects: projects.projectsWithoutChannel(db) }
  })

  app.get('/api/v1/admin/settings', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    return getAllSettings(db)
  })

  app.put('/api/v1/admin/settings/:key', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    return { key: req.params.key, value: setSetting(db, req.params.key, req.body, req.member.id) }
  })

  // S17-4：DeepSeek 测试连接（最小 completion，回显成败原因）
  app.post('/api/v1/admin/test-llm', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const { testLlmConnection } = await import('../brain/llm.js')
    const cfg = req.body?.baseUrl || req.body?.apiKey || req.body?.model
      ? { ...getSetting(db, 'llm'), ...req.body }
      : getSetting(db, 'llm')
    return testLlmConnection(cfg)
  })

  // S17-5：IM 连通性验证（企微未部署 SDK 时给出明确指引错误）
  app.post('/api/v1/admin/test-im/:platform', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const platform = req.params.platform
    if (!['feishu', 'wecom'].includes(platform)) return reply.status(400).send({ message: 'platform 仅支持 feishu/wecom' })
    const mod = await import(`../brain/connectors/${platform}.js`)
    return mod.testConnection(getSetting(db, `im.${platform}`))
  })

  app.get('/api/v1/admin/tokens', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const { listTokens: lt } = await import('../engine/auth.js')
    const rows = db.prepare('SELECT member_id FROM tokens GROUP BY member_id').all()
    const out = {}
    for (const r of rows) out[r.member_id] = lt(db, r.member_id)
    return { tokensByMember: out }
  })

  app.delete('/api/v1/admin/tokens/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    auth.revokeToken(db, Number(req.params.id), req.member.id)
    auth.audit(db, { memberId: req.member.id, action: 'token.adminRevoke', objectType: 'token', objectId: req.params.id })
    return { ok: true }
  })

  return app
}
