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
import { listPushes } from '../brain/push.js' // S46 通知收件箱
import { llmUsage } from '../engine/llmUsage.js' // S47 LLM 用量

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

  // S46（v0.51）：通知收件箱——本人推送记录（日报/预警/梳理/建议通知；投递状态三态：sent/failed/skipped）
  app.get('/api/v1/pushes', async (req) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 200)
    return { pushes: listPushes(db, { recipientMemberId: req.member.id, limit }) }
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
    // S8/S29：摘要必填（engine 强校验）；AI 草稿走 closeout-draft 端点预填、人工改后提交
    return projects.closeProject(db, Number(req.params.id), { summary: req.body?.summary }, req.member.id)
  })

  app.get('/api/v1/projects/:id/closeout-draft', async (req) => {
    // S8-2/S29：AI 复盘草稿（大脑基于事件流归纳，确定性降级兜底）——只产草稿不落库、不关项目
    const { closeoutSummary } = await import('../brain/digest.js')
    return { summary: await closeoutSummary(db, Number(req.params.id)) }
  })

  app.post('/api/v1/projects/:id/cancel', async (req) => {
    // S8-3/S29：原因必填（engine 强校验）；未完任务原样冻结
    return projects.cancelProject(db, Number(req.params.id), { reason: req.body?.reason }, req.member.id)
  })

  // S39（v0.42）+ S44（v0.45 异步化）：AI 初始分配——启动（同步校验后立即 202 返回 draftId，LLM 后台执行）
  // → 轮询（running/done/error，错误以 200 载荷返回，规避 PaaS 网关 5xx 替换）→ 人审应用（同步纯 DB 事务）；
  // Agent 通道 apply_init_assignments 可直写（K21 信任边界限定例外）
  app.post('/api/v1/projects/:id/draft-init-assignments', async (req, reply) => {
    const { startDraftInitAssignments } = await import('../brain/initAssign.js')
    const job = startDraftInitAssignments(db, Number(req.params.id), { llm: app.llm ?? undefined })
    auth.audit(db, { memberId: req.member.id, action: 'tasks.initAssignDraft', objectType: 'project', objectId: Number(req.params.id), detail: { draftId: job.draftId } })
    return reply.status(202).send(job)
  })

  app.get('/api/v1/projects/:id/draft-init-assignments/:draftId', async (req) => {
    const { getDraftInitAssignment } = await import('../brain/initAssign.js')
    return getDraftInitAssignment(Number(req.params.id), req.params.draftId)
  })

  app.post('/api/v1/projects/:id/init-assignments', async (req) =>
    tasks.applyInitAssignments(db, Number(req.params.id), req.body?.assignments, req.member.id)
  )

  // S37（v0.41）：项目硬删除——物理抹除（与「取消」的业务终态留痕互补），仅系统管理员
  app.delete('/api/v1/projects/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    projects.deleteProjectHard(db, Number(req.params.id), req.member.id)
    return { ok: true }
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

  // 任务删除（S36，v0.40）：软删留痕，全员可删（D1，与创建/更新同口径）；终态项目 409
  app.delete('/api/v1/tasks/:id', async (req) => {
    tasks.deleteTask(db, Number(req.params.id), req.member.id)
    return { ok: true }
  })

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
  // S4-7（v0.46/K25）：待确认建议一键批量处理（聚合回执，单条失败不阻塞其余）
  app.post('/api/v1/events/confirm-batch', async (req) => events.confirmEvents(db, req.body?.ids, req.member.id))
  app.post('/api/v1/events/reject-batch', async (req) => events.rejectEvents(db, req.body?.ids, req.member.id))

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

  // S47（v0.52，K30）：LLM 用量聚合——按用途（调用数/token/平均耗时/失败数）+ 按北京日汇总
  app.get('/api/v1/admin/llm-usage', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    return llmUsage(db, { days: Number(req.query.days) || 7 })
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

  // —— S34（v0.35）备份：S3 兼容存储（阿里云 OSS / Cloudflare R2 / AWS S3 / MinIO）——测试连通性 / 立即备份 / 历史 ——
  // body 可带未保存的覆盖值（同 test-llm 的 S17-4 语义：表单值可先测后存）
  app.post('/api/v1/admin/backup/test', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const { testBackupConnection } = await import('../engine/backup.js')
    const cfg = { ...getSetting(db, 'backup'), ...(req.body || {}) }
    const out = await testBackupConnection(cfg, { fetchImpl: app.backupFetch ?? undefined })
    auth.audit(db, { memberId: req.member.id, action: 'backup.test', objectType: 'backup', detail: { ok: out.ok, reason: out.reason } })
    return out
  })

  app.post('/api/v1/admin/backup/run', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const { runBackup } = await import('../engine/backup.js')
    try {
      return await runBackup(db, { memberId: req.member.id, fetchImpl: app.backupFetch ?? undefined })
    } catch (e) {
      // 上游失败不走 5xx（v0.21 PaaS 网关会替换响应体）：200 + {ok:false,reason}，服务端落 error 日志
      if (e.statusCode >= 500) {
        req.log.error(e)
        return { ok: false, reason: e.message }
      }
      throw e
    }
  })

  app.get('/api/v1/admin/backup/history', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const { listBackupHistory } = await import('../engine/backup.js')
    return { history: listBackupHistory(db) }
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

  // S17-13（v0.31）：删除类型——无引用守卫物理删除（级联清任务清单），有引用 400 提示停用
  app.delete('/api/v1/admin/project-types/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    projectTypes.deleteProjectType(db, Number(req.params.id), req.member.id)
    return { ok: true }
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
