import crypto from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupApp, loginCookie, authed, waitFor } from './helpers.mjs'
import { today, addDays } from '../db/time.js'
import { draftInitAssignments } from '../brain/initAssign.js'
import { createProposal } from '../engine/proposals.js'
import { upsertChannel, deleteTask } from '../engine/tasks.js'
import { handleBotEvent, handleCardAction } from '../brain/bot/command.js'
import { runWriteTool } from '../brain/bot/tools.js'
import { scriptedLlm, makeRecorder, makeMsgFactory, flattenPost, flattenCard, BOT_SECRET } from './bot-kit.mjs'

// PRD S64（v0.69）— 初始分配三层要求叠加 + 机器人触发（design.md K49）：
// 草案 LLM 输入按「类型 init_prompt → 项目 init_extra → 本次 extra」三层拼装（未配置层跳过）；
// 项目专题群 @ 机器人触发 → 立即回执 → S44 后台草案 → 草案确认卡推群（init_assignments 提议持久化）
// → 任意已绑定成员点「确认应用」批量生效（platform=bot）。

let ctx
beforeAll(async () => { ctx = await setupApp() })
afterAll(() => ctx?.db.close())

const hmac = (secret, canonical) => crypto.createHmac('sha256', secret).update(canonical).digest('hex').slice(0, 16)
const cardValue = (id, c) => ({ a: 'prop', p: String(id), c, s: hmac(BOT_SECRET, `prop:${c}:${id}`) })
const sentText = (m) => m.text ?? (m.post ? flattenPost(m.post) : m.card ? flattenCard(m.card) : '')
const fakeLlm = (handler) => ({ name: 'fake', complete: async (m) => handler(m) })

async function mkType(code, initPrompt) {
  const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
  const res = await authed(ctx.app, cookie, 'POST', '/api/v1/admin/project-types', {
    code, name: code, initPrompt, tasks: ['需求确认', '方案设计', '交付验收'],
  })
  expect(res.status).toBe(201)
  return res.body.type
}

async function mkProject(name, { typeCode = 's64_type', initExtra } = {}) {
  const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
  const res = await authed(ctx.app, cookie, 'POST', '/api/v1/projects', {
    name, typeCode, leadMemberId: ctx.members.lead.id, planStartDate: today(), planEndDate: addDays(today(), 30),
    ...(initExtra !== undefined ? { initExtra } : {}),
  })
  expect(res.status).toBe(201)
  return res.body
}

const draftJson = (tasks) => JSON.stringify({
  assignments: tasks.map((t) => ({
    taskId: t.id, responsibleMemberId: ctx.members.dev.id,
    planStartDate: today(), planEndDate: addDays(today(), 5),
  })),
})

async function bindGroup(projectId, chatId) {
  upsertChannel(ctx.db, { platform: 'feishu', groupKey: chatId, channelType: 'dedicated', projectId }, ctx.members.admin.id)
}

const pendingProposal = (projectId) =>
  ctx.db.prepare(`SELECT * FROM proposals WHERE kind = 'init_assignments' AND payload LIKE '%"projectId":${projectId}%' AND status = 'pending'`).get()

describe('S64 初始分配三层要求叠加与机器人触发', () => {
  it('S64-1: 立项 initExtra 落库回读一致（空串 NULL/超长非字符串 400）；提议通道同语义', async () => {
    await mkType('s64_type', '类型规则：需求类归交付部')

    const p = await mkProject('S64甲项目', { initExtra: '这期张三牵头，大部分开发任务给李四' })
    const detail = await authed(ctx.app, await loginCookie(ctx.app, 'admin', 'admin-pass-123'), 'GET', `/api/v1/projects/${p.id}`)
    expect(detail.body.initExtra).toBe('这期张三牵头，大部分开发任务给李四')

    // 空串归一 NULL；未传 = NULL
    const p2 = await mkProject('S64乙项目', { initExtra: '' })
    expect((await authed(ctx.app, await loginCookie(ctx.app, 'admin', 'admin-pass-123'), 'GET', `/api/v1/projects/${p2.id}`)).body.initExtra).toBeNull()

    // 超长 / 非字符串 → 400
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    expect((await authed(ctx.app, cookie, 'POST', '/api/v1/projects', {
      name: 'S64超长', typeCode: 's64_type', leadMemberId: ctx.members.lead.id, initExtra: 'x'.repeat(2001),
    })).status).toBe(400)
    expect((await authed(ctx.app, cookie, 'POST', '/api/v1/projects', {
      name: 'S64非串', typeCode: 's64_type', leadMemberId: ctx.members.lead.id, initExtra: 42,
    })).status).toBe(400)

    // 提议通道 create_project 携带 initExtra，确认生效后落库
    const prop = await createProposal(ctx.db, {
      kind: 'create_project',
      payload: { name: 'S64提议项目', typeCode: 's64_type', leadMemberId: ctx.members.lead.id, initExtra: '提议通道的补充要求' },
      summary: '立项「S64提议项目」', proposedBy: ctx.members.admin.id,
    })
    const { confirmProposal } = await import('../engine/proposals.js')
    await confirmProposal(ctx.db, prop.id, ctx.members.admin.id)
    expect(ctx.db.prepare(`SELECT init_extra FROM projects WHERE name = 'S64提议项目'`).get().init_extra).toBe('提议通道的补充要求')
  })

  it('S64-2: 草案 LLM 输入三层依次拼装（类型→项目→本次），未配置层跳过不占位', async () => {
    const p = await mkProject('S64丙项目', { initExtra: '项目级：彩排安排在交付前 3 天' })
    let seen = null
    const out = await draftInitAssignments(ctx.db, p.id, {
      llm: fakeLlm((m) => { seen = m; return draftJson(p.tasks) }),
      extra: '本次：验收前留两天缓冲',
    })
    expect(out.assignments).toHaveLength(p.tasks.length)
    const user = seen.find((m) => m.role === 'user').content
    expect(user).toContain('初始化提示词：')
    expect(user).toContain('类型规则：需求类归交付部')
    expect(user).toContain('项目补充要求：')
    expect(user).toContain('项目级：彩排安排在交付前 3 天')
    expect(user).toContain('本次追加要求：')
    expect(user).toContain('本次：验收前留两天缓冲')

    // 未配置层跳过：不带类型提示词的类型 + 无 initExtra + 不传 extra → 只剩类型层兜底句，无另两层占位
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    await authed(ctx.app, cookie, 'POST', '/api/v1/admin/project-types', { code: 's64_bare', name: '裸类型', tasks: ['甲步骤', '乙步骤'] })
    const p2 = await mkProject('S64丁项目', { typeCode: 's64_bare' })
    let seen2 = null
    await draftInitAssignments(ctx.db, p2.id, { llm: fakeLlm((m) => { seen2 = m; return draftJson(p2.tasks) }) })
    const user2 = seen2.find((m) => m.role === 'user').content
    expect(user2).toContain('初始化提示词：')
    expect(user2).toContain('未配置')
    expect(user2).not.toContain('项目补充要求：')
    expect(user2).not.toContain('本次追加要求：')
  })

  it('S64-3: PATCH /projects/:id 可改 initExtra（同归一规则）；未传不动', async () => {
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const p = await mkProject('S64戊项目', { initExtra: '旧要求' })
    const upd = await authed(ctx.app, cookie, 'PATCH', `/api/v1/projects/${p.id}`, { initExtra: '新要求：优先交付北门' })
    expect(upd.status).toBe(200)
    expect(upd.body.initExtra).toBe('新要求：优先交付北门')

    // 只改其他字段 → initExtra 不动（patch 语义）
    await authed(ctx.app, cookie, 'PATCH', `/api/v1/projects/${p.id}`, { priority: 'high' })
    expect((await authed(ctx.app, cookie, 'GET', `/api/v1/projects/${p.id}`)).body.initExtra).toBe('新要求：优先交付北门')

    expect((await authed(ctx.app, cookie, 'PATCH', `/api/v1/projects/${p.id}`, { initExtra: 'y'.repeat(2001) })).status).toBe(400)
    const cleared = await authed(ctx.app, cookie, 'PATCH', `/api/v1/projects/${p.id}`, { initExtra: '' })
    expect(cleared.body.initExtra).toBeNull()
  })

  it('S64-4: web 弹窗「本次追加要求」随草案启动提交并进入三层拼装；应用链路不变', async () => {
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const p = await mkProject('S64己项目', { initExtra: '项目级：开发任务给李四' })
    let seen = null
    ctx.app.llm = fakeLlm((m) => { seen = m; return draftJson(p.tasks) })
    const started = await authed(ctx.app, cookie, 'POST', `/api/v1/projects/${p.id}/draft-init-assignments`, { extra: 'web 本次追加：日期尽量靠前' })
    expect(started.status).toBe(202)
    let last
    await waitFor(async () => {
      last = await authed(ctx.app, cookie, 'GET', `/api/v1/projects/${p.id}/draft-init-assignments/${started.body.draftId}`)
      return last.body.status !== 'running'
    }, { timeoutMs: 3000 })
    expect(last.body.status).toBe('done')
    const user = seen.find((m) => m.role === 'user').content
    expect(user).toContain('web 本次追加：日期尽量靠前')
    expect(user).toContain('项目级：开发任务给李四')
    // 应用链路（S39）不变：人审后应用仍走 init-assignments
    const applied = await authed(ctx.app, cookie, 'POST', `/api/v1/projects/${p.id}/init-assignments`, { assignments: last.body.assignments })
    expect(applied.status).toBe(200)
    expect(applied.body.updated).toBe(p.tasks.length)
  })

  it('S64-5: 专题群 @ 机器人触发——立即回执「生成中」，口述要求提炼进 extra 传入草案；未定域项目给引导', async () => {
    const p = await mkProject('S64庚项目', { initExtra: '项目级：设计任务归内容组' })
    await bindGroup(p.id, 'oc_s64_main')
    const rec = makeRecorder()()
    const factory = makeMsgFactory('om_s64a')
    const s = scriptedLlm(
      '{"action":"write","kind":"init_assign","payload":{"extra":"张三牵头，开发任务多给李四，11月中前收口"}}',
      draftJson(p.tasks),
    )
    const out = await handleBotEvent(ctx.db, factory.group('fs_zhang', 'oc_s64_main', '@大脑 初始分配一下，这期张三牵头，开发任务多给李四，11月中前收口', { mentioned: true }), {
      llm: s.llm, send: rec.send, secret: BOT_SECRET,
    })
    expect(out.result).toBe('replied')
    expect(sentText(rec.sent[0])).toContain('生成中')
    // 后台草案完成 → 提议落库 + 卡片推回本群
    await waitFor(() => pendingProposal(p.id) && rec.sent.length >= 2, { timeoutMs: 3000 })
    // 口述要求提炼进 extra，且与项目级要求同入 LLM 草案上下文（第二通 complete = 草案调用）
    const draftUser = s.calls[1].find((m) => m.role === 'user').content
    expect(draftUser).toContain('张三牵头，开发任务多给李四，11月中前收口')
    expect(draftUser).toContain('项目级：设计任务归内容组')

    // 无定域项目（未绑定群 + 未点名 projectId）→ 引导文案，不发起
    const direct = await runWriteTool(ctx.db, { kind: 'init_assign', payload: { extra: 'x' } }, {
      member: ctx.members.lead, evt: { platform: 'feishu', chatId: 'oc_unbound', chatType: 'group' }, llm: s.llm,
    })
    expect(direct.type).toBe('refused')
    expect(direct.text).toMatch(/专题群|项目/)
  })

  it('S64-6: 草案完成推确认卡（任务/责任人/起止+追加要求回显）并落 pending 提议；无任务/失败降级文本', async () => {
    const p = await mkProject('S64辛项目')
    await bindGroup(p.id, 'oc_s64_card')
    const rec = makeRecorder()()
    const factory = makeMsgFactory('om_s64b')
    const s = scriptedLlm(
      '{"action":"write","kind":"init_assign","payload":{"extra":"全部给李四"}}',
      draftJson(p.tasks),
    )
    await handleBotEvent(ctx.db, factory.group('fs_zhang', 'oc_s64_card', '@大脑 初始分配，全部给李四', { mentioned: true }), {
      llm: s.llm, send: rec.send, secret: BOT_SECRET,
    })
    await waitFor(() => pendingProposal(p.id) && rec.sent.length >= 2, { timeoutMs: 3000 })
    const prop = pendingProposal(p.id)
    expect(prop).toBeTruthy()
    const payload = JSON.parse(prop.payload)
    expect(payload.projectId).toBe(p.id)
    expect(payload.assignments).toHaveLength(p.tasks.length)
    expect(payload.extra).toBe('全部给李四')
    const cardMsg = rec.sent.slice(1).find((m) => m.card)
    expect(cardMsg).toBeTruthy()
    const flat = flattenCard(cardMsg.card)
    expect(flat).toContain(p.tasks[0].title)
    expect(flat).toContain('李四')
    expect(flat).toContain('全部给李四')

    // 无未完成任务 → 文本降级，不落提议
    const p2 = await mkProject('S64壬项目')
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    for (const t of p2.tasks) await authed(ctx.app, cookie, 'PATCH', `/api/v1/tasks/${t.id}`, { status: 'done' })
    await bindGroup(p2.id, 'oc_s64_none')
    const rec2 = makeRecorder()()
    const s2 = scriptedLlm('{"action":"write","kind":"init_assign","payload":{}}')
    await handleBotEvent(ctx.db, makeMsgFactory('om_s64c').group('fs_zhang', 'oc_s64_none', '@大脑 初始分配', { mentioned: true }), {
      llm: s2.llm, send: rec2.send, secret: BOT_SECRET,
    })
    await waitFor(() => rec2.sent.length >= 2, { timeoutMs: 3000 })
    // 无任务场景草案作业同步即完成，推送与回执的先后顺序不定——并集断言
    expect(rec2.sent.map(sentText).join('\n')).toMatch(/没有未完成|没有可分配/)
    expect(pendingProposal(p2.id)).toBeFalsy()

    // 草案失败 → 文本提示（含中文错误），不落提议
    const p3 = await mkProject('S64癸项目')
    await bindGroup(p3.id, 'oc_s64_err')
    const rec3 = makeRecorder()()
    let n = 0
    const s3 = { llm: { name: 'fake', complete: async () => { if (++n === 1) return '{"action":"write","kind":"init_assign","payload":{}}'; throw new Error('LLM 响应超时（已自动重试一次）') } } }
    await handleBotEvent(ctx.db, makeMsgFactory('om_s64d').group('fs_zhang', 'oc_s64_err', '@大脑 初始分配', { mentioned: true }), {
      llm: s3.llm, send: rec3.send, secret: BOT_SECRET,
    })
    await waitFor(() => rec3.sent.length >= 2, { timeoutMs: 3000 })
    expect(rec3.sent.map(sentText).join('\n')).toMatch(/失败|超时/)
    expect(pendingProposal(p3.id)).toBeFalsy()
  })

  it('S64-7: 卡片确认→批量生效（事件+审计 platform=bot）；放弃→rejected；快照失效→提示重新发起；未绑定点按忽略', async () => {
    const p = await mkProject('S64子项目')
    await bindGroup(p.id, 'oc_s64_confirm')
    const rec = makeRecorder()()
    const s = scriptedLlm('{"action":"write","kind":"init_assign","payload":{}}', draftJson(p.tasks))
    await handleBotEvent(ctx.db, makeMsgFactory('om_s64e').group('fs_zhang', 'oc_s64_confirm', '@大脑 初始分配', { mentioned: true }), {
      llm: s.llm, send: rec.send, secret: BOT_SECRET,
    })
    await waitFor(() => pendingProposal(p.id) && rec.sent.length >= 2, { timeoutMs: 3000 })
    const prop = pendingProposal(p.id)

    // 任意已绑定成员（李四，非牵头人非管理员）点「确认应用」→ 单事务批量生效
    const recCard = makeRecorder()()
    const confirmed = await handleCardAction(ctx.db, {
      operatorOpenId: 'fs_li', chatId: 'oc_s64_confirm', messageId: 'card_s64_ok', value: cardValue(prop.id, 'confirm'),
    }, { send: recCard.send, secret: BOT_SECRET })
    expect(confirmed.result).toBe('confirmed')
    expect(confirmed.text).toContain(`${p.tasks.length} 项`)
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND responsible_member_id = ?').get(p.id, ctx.members.dev.id).n).toBe(p.tasks.length)
    const evtRow = ctx.db.prepare(`SELECT * FROM project_events WHERE project_id = ? AND summary LIKE '%初始化分配%'`).get(p.id)
    expect(evtRow.source_platform).toBe('bot')
    expect(ctx.db.prepare(`SELECT * FROM audit_logs WHERE action = 'task.initAssign'`).get()).toBeTruthy()
    expect(ctx.db.prepare('SELECT status FROM proposals WHERE id = ?').get(prop.id).status).toBe('effective')

    // 放弃 → rejected
    const p2 = await mkProject('S64丑项目')
    const prop2 = await createProposal(ctx.db, {
      kind: 'init_assignments', payload: { projectId: p2.id, assignments: draftJson(p2.tasks) ? JSON.parse(draftJson(p2.tasks)).assignments : [], extra: null },
      summary: `初始分配草案：项目「${p2.name}」`, proposedBy: ctx.members.lead.id,
    })
    const rejected = await handleCardAction(ctx.db, {
      operatorOpenId: 'fs_li', chatId: 'oc_s64_confirm', messageId: 'card_s64_rej', value: cardValue(prop2.id, 'reject'),
    }, { send: makeRecorder()().send, secret: BOT_SECRET })
    expect(rejected.result).toBe('rejected')
    expect(ctx.db.prepare('SELECT status FROM proposals WHERE id = ?').get(prop2.id).status).toBe('rejected')
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND responsible_member_id IS NOT NULL').get(p2.id).n).toBe(0)

    // 快照语义：草案后任务被删 → 确认 400 提示重新发起，不部分落库
    const p3 = await mkProject('S64寅项目')
    const assignments = JSON.parse(draftJson(p3.tasks)).assignments
    const prop3 = await createProposal(ctx.db, {
      kind: 'init_assignments', payload: { projectId: p3.id, assignments, extra: null },
      summary: `初始分配草案：项目「${p3.name}」`, proposedBy: ctx.members.lead.id,
    })
    deleteTask(ctx.db, p3.tasks[0].id, ctx.members.admin.id)
    const stale = await handleCardAction(ctx.db, {
      operatorOpenId: 'fs_li', chatId: 'oc_s64_confirm', messageId: 'card_s64_stale', value: cardValue(prop3.id, 'confirm'),
    }, { send: makeRecorder()().send, secret: BOT_SECRET })
    expect(stale.result).toBe('error')
    expect(stale.text).toMatch(/重新发起|快照/)
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND responsible_member_id IS NOT NULL').get(p3.id).n).toBe(0)

    // 未绑定成员点按 → 拒绝（不生效）
    const p4 = await mkProject('S64卯项目')
    const prop4 = await createProposal(ctx.db, {
      kind: 'init_assignments', payload: { projectId: p4.id, assignments: JSON.parse(draftJson(p4.tasks)).assignments, extra: null },
      summary: `初始分配草案：项目「${p4.name}」`, proposedBy: ctx.members.lead.id,
    })
    const unbound = await handleCardAction(ctx.db, {
      operatorOpenId: 'fs_unknown', chatId: 'oc_s64_confirm', messageId: 'card_s64_unbound', value: cardValue(prop4.id, 'confirm'),
    }, { send: makeRecorder()().send, secret: BOT_SECRET })
    expect(unbound.result).toBe('refused_permission')
    expect(ctx.db.prepare('SELECT status FROM proposals WHERE id = ?').get(prop4.id).status).toBe('pending')
  })

  it('S64-8: 任意已绑定成员可触发；LLM 未配置回执配置指引；终态项目拒绝', async () => {
    // 李四（普通成员）在专题群触发 → 放行（与 web 全员口径一致）
    const p = await mkProject('S64辰项目')
    await bindGroup(p.id, 'oc_s64_dev')
    const rec = makeRecorder()()
    const s = scriptedLlm('{"action":"write","kind":"init_assign","payload":{}}', draftJson(p.tasks))
    const out = await handleBotEvent(ctx.db, makeMsgFactory('om_s64f').group('fs_li', 'oc_s64_dev', '@大脑 帮我初始分配', { mentioned: true }), {
      llm: s.llm, send: rec.send, secret: BOT_SECRET,
    })
    expect(out.result).toBe('replied')
    await waitFor(() => pendingProposal(p.id), { timeoutMs: 3000 })

    // LLM 未配置（直接调写工具，push 注入但无 llm 且库内无 LLM 配置）→ refused 配置指引
    const noLlm = await runWriteTool(ctx.db, { kind: 'init_assign', payload: {} }, {
      member: ctx.members.lead, evt: { platform: 'feishu', chatId: 'oc_s64_dev', chatType: 'group' },
      llm: undefined, push: async () => ({ messageId: null }),
    })
    expect(noLlm.type).toBe('refused')
    expect(noLlm.text).toMatch(/LLM 未配置/)

    // 终态项目 → 拒绝（409 语义文案）
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const p2 = await mkProject('S64巳项目')
    for (const t of p2.tasks) await authed(ctx.app, cookie, 'PATCH', `/api/v1/tasks/${t.id}`, { status: 'done' })
    await authed(ctx.app, cookie, 'POST', `/api/v1/projects/${p2.id}/close`, { summary: '交付完成' })
    const closed = await runWriteTool(ctx.db, { kind: 'init_assign', payload: { projectId: p2.id } }, {
      member: ctx.members.lead, evt: { platform: 'feishu', chatId: 'oc_s64_dev', chatType: 'group' },
      llm: { name: 'fake', complete: async () => draftJson(p2.tasks) }, push: async () => ({ messageId: null }),
    })
    expect(closed.type).toBe('refused')
    expect(closed.text).toMatch(/任务面只读/)
  })

  it('S64-9: Agent action draft_init_assignments 支持可选 extra 透传进草案', async () => {
    const login = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/agent-login', payload: { username: 'zhangsan', password: 'pass-123456' } })
    const writeToken = login.json().token
    const p = await mkProject('S64午项目', { initExtra: '项目级：验收给王五' })
    let seen = null
    ctx.app.llm = fakeLlm((m) => { seen = m; return draftJson(p.tasks) })
    const started = await ctx.app.inject({
      method: 'POST', url: '/api/v1/agent/actions',
      payload: { action: 'draft_init_assignments', params: { projectId: p.id, extra: 'agent 本次追加：优先级从高到低铺开' } },
      headers: { authorization: `Bearer ${writeToken}` },
    })
    expect(started.statusCode).toBe(200)
    let last
    await waitFor(async () => {
      const res = await ctx.app.inject({
        method: 'GET', url: `/api/v1/agent/draft-init-assignments/${started.json().result.draftId}?projectId=${p.id}`,
        headers: { authorization: `Bearer ${writeToken}` },
      })
      last = res.json()
      return last.status !== 'running'
    }, { timeoutMs: 3000 })
    expect(last.status).toBe('done')
    const user = seen.find((m) => m.role === 'user').content
    expect(user).toContain('agent 本次追加：优先级从高到低铺开')
    expect(user).toContain('项目级：验收给王五')
  })
})
