// 业务路由：参数校验 + 权限校验 + 调 engine（不写业务 SQL）
import * as members from '../engine/members.js'
import * as projects from '../engine/projects.js'
import * as tasks from '../engine/tasks.js'
import * as events from '../engine/events.js'
import * as projectTypes from '../engine/projectTypes.js'
import * as auth from '../engine/auth.js'
import * as chat from '../brain/chat.js' // S24 Web AI 助手会话（编排层复用 S20 核心 Agent）
import * as proposalsEngine from '../engine/proposals.js' // S25 通用提议确认口子
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

  // S20-4：飞书绑定码（成员自助生成；10 分钟一次性，仅私聊 /bind 消费，凭据不经 LLM）
  app.post('/api/v1/auth/feishu-bind-code', async (req) => {
    const { issueBindCode } = await import('../brain/bot/command.js')
    const out = issueBindCode(db, req.member.id)
    auth.audit(db, { memberId: req.member.id, action: 'bot.bindCode', objectType: 'member', objectId: req.member.id })
    return out
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

  // 项目类型清单：登录可读（立项表单选项；D1 全员透明），维护在 /admin 段
  app.get('/api/v1/project-types', async () => ({ types: projectTypes.listProjectTypes(db) }))

  app.get('/api/v1/projects', async (req) => {
    const statuses = req.query.status ? String(req.query.status).split(',') : undefined
    return { projects: projects.listProjects(db, { statuses }) }
  })

  app.post('/api/v1/projects', async (req, reply) => {
    return reply.status(201).send(projects.createProject(db, req.body, req.member.id))
  })

  // S17-9（v0.18）：任务清单 AI 起草——类型编辑器/立项弹窗共用（立项全员可用，故本端点全员；草稿不落库）
  app.post('/api/v1/projects/draft-tasks', async (req) => {
    const { name, description } = req.body || {}
    if (!name || !String(name).trim()) throw Object.assign(new Error('name 必填（项目名或类型名）'), { statusCode: 400 })
    const { draftTaskList } = await import('../brain/templates.js')
    const out = await draftTaskList(db, { name: String(name).trim(), description }, { llm: app.llm ?? undefined })
    auth.audit(db, { memberId: req.member.id, action: 'tasks.draft', objectType: 'project', detail: { name: String(name).trim(), tasks: out.tasks.length } })
    return out
  })

  // S1-7：倒排预览——engine 同一公式（不落库），立项弹窗与 AI 提议共用
  app.post('/api/v1/projects/preview-schedule', async (req) => {
    const { planStartDate, planEndDate, count } = req.body || {}
    const n = Number(count)
    if (!Number.isInteger(n) || n < 1 || n > 100) throw Object.assign(new Error('count 须为 1~100 的整数'), { statusCode: 400 })
    return { schedule: projects.backScheduleDates({ planStartDate: planStartDate || undefined, planEndDate, count: n }) }
  })

  app.get('/api/v1/projects/:id', async (req) => projects.getProjectDetail(db, Number(req.params.id)))

  app.patch('/api/v1/projects/:id', async (req) => projects.updateProject(db, Number(req.params.id), req.body, req.member.id))

  app.post('/api/v1/projects/:id/close', async (req) => {
    // S8-2：未提供摘要时由大脑基于事件流自动生成（LLM 可用则归纳，人工可改）；v0.6 规则=全部任务完成才可结项
    let summary = req.body?.summary
    if (!summary) {
      const { closeoutSummary } = await import('../brain/digest.js')
      summary = await closeoutSummary(db, Number(req.params.id))
    }
    return projects.closeProject(db, Number(req.params.id), { summary }, req.member.id)
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

  // 任务更新记录（S2-3，v0.6）：追加式时间线
  app.get('/api/v1/tasks/:id/records', async (req) => ({ records: tasks.listTaskRecords(db, Number(req.params.id)) }))

  app.post('/api/v1/tasks/:id/records', async (req, reply) => {
    return reply.status(201).send({ record: tasks.addTaskRecord(db, { taskId: Number(req.params.id), content: req.body?.content }, req.member.id) })
  })

  // 任务参考资料（S23，v0.13）：SOP/知识库链接，全员可维护（D1）留审计；推送附带给执行人
  app.get('/api/v1/tasks/:id/refs', async (req) => ({ refs: tasks.listTaskRefs(db, Number(req.params.id)) }))

  app.post('/api/v1/tasks/:id/refs', async (req, reply) => {
    return reply.status(201).send(
      { ref: tasks.addTaskRef(db, { taskId: Number(req.params.id), title: req.body?.title, url: req.body?.url, note: req.body?.note }, req.member.id) }
    )
  })

  app.patch('/api/v1/tasks/:id/refs/:refId', async (req) =>
    ({ ref: tasks.updateTaskRef(db, Number(req.params.refId), req.body, req.member.id) }))

  app.delete('/api/v1/tasks/:id/refs/:refId', async (req) => {
    tasks.deleteTaskRef(db, Number(req.params.refId), req.member.id)
    return { ok: true }
  })

  app.post('/api/v1/milestones', async (req, reply) => {
    return reply.status(201).send(tasks.createMilestone(db, req.body, req.member.id))
  })

  app.patch('/api/v1/milestones/:id', async (req) => tasks.updateMilestone(db, Number(req.params.id), req.body, req.member.id))

  app.get('/api/v1/channels', async () => ({ channels: tasks.listChannels(db) }))

  // S17-12：渠道写权限——管理员全可；非管理员仅目标（删除时=当前绑定）项目的牵头人可维护专题渠道；通用群仅管理员
  app.post('/api/v1/channels', async (req, reply) => {
    if (!tasks.canManageChannel(db, req.member, req.body)) {
      return reply.status(403).send({ message: '仅系统管理员或项目牵头人可维护渠道（通用群仅系统管理员）' })
    }
    return reply.status(201).send(tasks.upsertChannel(db, req.body, req.member.id))
  })

  app.delete('/api/v1/channels/:id', async (req, reply) => {
    if (!tasks.canDeleteChannel(db, req.member, Number(req.params.id))) {
      return reply.status(403).send({ message: '仅系统管理员或绑定项目牵头人可删除渠道' })
    }
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

  // —— S25 通用提议：确认/驳回（权限矩阵在 engine/proposals.js；与飞书卡片同一口子） ——
  app.post('/api/v1/proposals/:id/confirm', async (req) => proposalsEngine.confirmProposal(db, Number(req.params.id), req.member.id))
  app.post('/api/v1/proposals/:id/reject', async (req) => proposalsEngine.rejectProposal(db, Number(req.params.id), req.member.id))

  // —— S24 Web AI 助手会话（全员；会话与消息仅本人，软删） ——
  app.get('/api/v1/chat/sessions', async (req) => chat.listSessions(db, req.member.id))
  app.post('/api/v1/chat/sessions', async (req, reply) =>
    reply.status(201).send(chat.createSession(db, req.member.id, { title: req.body?.title })))
  app.patch('/api/v1/chat/sessions/:id', async (req) => chat.renameSession(db, req.member.id, Number(req.params.id), req.body?.title))
  app.delete('/api/v1/chat/sessions/:id', async (req) => chat.deleteSession(db, req.member.id, Number(req.params.id)))
  app.get('/api/v1/chat/sessions/:id/messages', async (req) => chat.listMessages(db, req.member.id, Number(req.params.id)))
  app.post('/api/v1/chat/sessions/:id/messages', async (req) =>
    chat.sendChatMessage(db, { memberId: req.member.id, sessionId: Number(req.params.id), text: req.body?.text }, { llm: app.llm ?? undefined }))

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
    const value = setSetting(db, req.params.key, req.body, req.member.id)
    // S20-12（v0.22）：im.feishu 保存即热生效——网关按新配置立即重连/断开，无需重启进程；botSync 注入点供测试
    let bot
    if (req.params.key === 'im.feishu') {
      bot = app.botSync
        ? await app.botSync()
        : await (await import('../brain/bot/gateway.js')).syncBot(db, { secret: process.env.GB_PMO_SESSION_SECRET || '' })
    }
    return { key: req.params.key, value, bot }
  })

  // S18-1：管理员手动「立即对齐」——立即增量拉取并抽取（收集新记录、更新项目最新状态），回显每渠道结果
  app.post('/api/v1/admin/extraction/run', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const { channelId, projectId } = req.body || {}
    if (channelId !== undefined && !Number.isInteger(channelId)) return reply.status(400).send({ message: 'channelId 须为整数' })
    if (projectId !== undefined && !Number.isInteger(projectId)) return reply.status(400).send({ message: 'projectId 须为整数' })
    const { runExtraction } = await import('../brain/extract.js')
    const result = await runExtraction(db, { channelId, projectId }, { llm: app.llm ?? undefined })
    auth.audit(db, { memberId: req.member.id, action: 'extraction.run', objectType: 'channel', detail: { channelId, projectId } })
    return result
  })

  // S17-4：LLM 测试连接（最小 completion，回显成败原因）。v0.15：按类别分开存储——
  // body 可带 provider（未保存的切换也可先测）与 apiKey/baseUrl/model 覆盖值，缺省取该类别已存子配置。
  app.post('/api/v1/admin/test-llm', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const { testLlmConnection } = await import('../brain/llm.js')
    const saved = getSetting(db, 'llm')
    const body = req.body || {}
    const provider = body.provider ?? saved.provider
    const sub = saved[provider] ?? {}
    return testLlmConnection({
      provider,
      apiKey: body.apiKey ?? sub.apiKey,
      baseUrl: body.baseUrl ?? sub.baseUrl,
      model: body.model ?? sub.model,
      timeoutMs: saved.timeoutMs,
    })
  })

  // S17-5：IM 连通性验证（企微未部署 SDK 时给出明确指引错误）
  app.post('/api/v1/admin/test-im/:platform', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const platform = req.params.platform
    if (!['feishu', 'wecom'].includes(platform)) return reply.status(400).send({ message: 'platform 仅支持 feishu/wecom' })
    const mod = await import(`../brain/connectors/${platform}.js`)
    return mod.testConnection(getSetting(db, `im.${platform}`))
  })

  // —— S26（v0.19）管理员诊断台：诊断 shell（开关默认关）+ 飞书长连接三段自检；全程审计 ——
  app.post('/api/v1/admin/debug/shell', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const { runShell } = await import('../engine/debug.js')
    return runShell(db, req.body?.command, req.member.id)
  })

  app.post('/api/v1/admin/debug/feishu-selfcheck', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const feishu = await import('../brain/connectors/feishu.js')
    const out = await feishu.selfCheck(getSetting(db, 'im.feishu'))
    auth.audit(db, {
      memberId: req.member.id, action: 'debug.feishuSelfcheck', objectType: 'debug',
      detail: { ok: out.ok, stages: out.stages.map((s) => `${s.stage}:${s.ok ? 'ok' : 'fail'}`) },
    })
    return out
  })

  // S22：飞书项目日历——初始化（创建组织内可订阅日历并保存 calendar_id）+ 立即同步（对账式）
  app.post('/api/v1/admin/calendar/init', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const { initProjectCalendar } = await import('../brain/calendar.js')
    try {
      const out = await initProjectCalendar(db, req.member.id)
      auth.audit(db, { memberId: req.member.id, action: 'calendar.init', objectType: 'calendar', objectId: out.calendarId })
      return out
    } catch (e) {
      // S22-6（v0.21）：上游失败不走 5xx——PaaS 网关（Zeabur/Cloudflare）会把应用 5xx 响应体
      // 替换成网关自己的错误页，错误文案到不了界面；改 200 + {ok:false, reason}（同 testConnection
      // 模式，4xx 校验错误仍走原样抛出），服务端落 error 日志并留失败审计
      if (e.statusCode >= 500) {
        req.log.error(e)
        auth.audit(db, { memberId: req.member.id, action: 'calendar.init', objectType: 'calendar', detail: { error: e.message } })
        return { ok: false, reason: e.message }
      }
      throw e
    }
  })

  app.post('/api/v1/admin/calendar/sync', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const { syncProjectCalendar } = await import('../brain/calendar.js')
    const out = await syncProjectCalendar(db)
    auth.audit(db, {
      memberId: req.member.id, action: 'calendar.sync', objectType: 'calendar',
      detail: { created: out.created ?? 0, updated: out.updated ?? 0, skipped: out.skipped === true ? '未初始化' : out.skipped ?? 0, errors: out.errors?.length ?? 0 },
    })
    return out
  })

  // S17-8（v0.18）：项目类型管理（内嵌任务清单；任务模板对象已裁撤，仅系统管理员）
  app.post('/api/v1/admin/project-types', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    return reply.status(201).send({ type: projectTypes.createProjectType(db, req.body, req.member.id) })
  })

  app.patch('/api/v1/admin/project-types/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    return { type: projectTypes.updateProjectType(db, Number(req.params.id), req.body, req.member.id) }
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
