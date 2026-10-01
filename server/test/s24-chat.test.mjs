import { describe, it, expect, afterAll } from 'vitest'
import { setupApp, loginCookie, authed } from './helpers.mjs'

// PRD S24（v0.16）— Web AI 助手会话：与 S20 同一核心 Agent 的 web 入口
// 会话管理（CRUD/归属隔离/软删）、多轮上下文、写信任边界、限额与审计、降级

let ctx
afterAll(() => { ctx?.db.close(); globalThis.fetch = undefined })

/** 逐轮回放动作序列的 fake LLM（S20 同款协议：每轮输出一个 JSON 动作） */
function fakeLlm(turns, capture) {
  return {
    name: 'fake',
    async complete(messages, opts) {
      capture?.push({ messages: messages.map((m) => m.role), lastUser: String(messages.at(-1)?.content || ''), opts })
      const out = turns.shift() ?? { action: 'reply', text: '（fake 兜底）' }
      return JSON.stringify(out)
    },
  }
}

async function mkProject(app, cookie, leadId, name) {
  const res = await authed(app, cookie, 'POST', '/api/v1/projects', {
    name, templateCode: 'software_delivery', leadMemberId: leadId, planEndDate: '2026-12-31',
  })
  return res.body
}

describe('S24 Web AI 助手会话', () => {
  it('S24-1: 会话 CRUD——仅本人可见可操作（他人 404），删除为软删', async () => {
    ctx = await setupApp()
    const adminCookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const leadCookie = await loginCookie(ctx.app, 'zhangsan', 'pass-123456')

    const created = await authed(ctx.app, adminCookie, 'POST', '/api/v1/chat/sessions', {})
    expect(created.status).toBe(201)
    const sid = created.body.id
    expect(created.body.title).toBe('新会话')

    // 归属隔离：他人列表看不到、改名/删消息 404
    const mine = await authed(ctx.app, adminCookie, 'GET', '/api/v1/chat/sessions')
    expect(mine.body.sessions.length).toBe(1)
    const others = await authed(ctx.app, leadCookie, 'GET', '/api/v1/chat/sessions')
    expect(others.body.sessions.length).toBe(0)
    expect((await authed(ctx.app, leadCookie, 'PATCH', `/api/v1/chat/sessions/${sid}`, { title: 'x' })).status).toBe(404)
    expect((await authed(ctx.app, leadCookie, 'GET', `/api/v1/chat/sessions/${sid}/messages`)).status).toBe(404)
    expect((await authed(ctx.app, leadCookie, 'DELETE', `/api/v1/chat/sessions/${sid}`)).status).toBe(404)

    const renamed = await authed(ctx.app, adminCookie, 'PATCH', `/api/v1/chat/sessions/${sid}`, { title: '交付排期' })
    expect(renamed.body.title).toBe('交付排期')

    // 软删：列表消失、行保留
    expect((await authed(ctx.app, adminCookie, 'DELETE', `/api/v1/chat/sessions/${sid}`)).status).toBe(200)
    expect((await authed(ctx.app, adminCookie, 'GET', '/api/v1/chat/sessions')).body.sessions.length).toBe(0)
    expect((await authed(ctx.app, adminCookie, 'GET', `/api/v1/chat/sessions/${sid}/messages`)).status).toBe(404)
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM chat_sessions WHERE deleted_at IS NOT NULL').get().n).toBe(1)
  })

  it('S24-2: 发消息——多轮上下文、双落库、标题自动生成、审计入 bot_commands', async () => {
    ctx = await setupApp()
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const sid = (await authed(ctx.app, cookie, 'POST', '/api/v1/chat/sessions', {})).body.id

    const capture = []
    ctx.app.llm = fakeLlm([
      { action: 'query', sql: 'SELECT COUNT(*) AS n FROM projects' },
      { action: 'reply', text: '当前共 0 个项目。' },
    ], capture)
    const first = await authed(ctx.app, cookie, 'POST', `/api/v1/chat/sessions/${sid}/messages`, { text: '现在有几个项目？' })
    expect(first.status).toBe(200)
    expect(first.body.user.content).toBe('现在有几个项目？')
    expect(first.body.assistant.content).toBe('当前共 0 个项目。')
    expect(first.body.assistant.meta).toMatchObject({ result: 'replied', llmCalls: 2, queries: 1 })

    // 标题自动生成（前 20 字）；消息双双落库
    const sess = (await authed(ctx.app, cookie, 'GET', '/api/v1/chat/sessions')).body.sessions[0]
    expect(sess.title).toBe('现在有几个项目？')
    const msgs = (await authed(ctx.app, cookie, 'GET', `/api/v1/chat/sessions/${sid}/messages`)).body.messages
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant'])

    // 第二条消息携带多轮上下文（history 注入 system 之后）
    ctx.app.llm = fakeLlm([{ action: 'reply', text: '好的。' }], capture)
    const second = await authed(ctx.app, cookie, 'POST', `/api/v1/chat/sessions/${sid}/messages`, { text: '帮我盯着就行' })
    expect(second.status).toBe(200)
    const last = capture.at(-1)
    expect(last.messages.slice(0, 4)).toEqual(['system', 'user', 'assistant', 'user'])
    // 已改过名的会话（自动改名后）标题不被第二条覆盖
    expect((await authed(ctx.app, cookie, 'GET', '/api/v1/chat/sessions')).body.sessions[0].title).toBe('现在有几个项目？')

    // 审计：两条指令都落 bot_commands（platform=web）
    const rows = ctx.db.prepare(`SELECT * FROM bot_commands WHERE platform = 'web' AND kind = 'command' ORDER BY id`).all()
    expect(rows.length).toBe(2)
    expect(rows[0].result).toBe('replied')
    expect(rows[0].llm_calls).toBe(2)
    expect(rows[0].raw_text).toBe('现在有几个项目？')
  })

  it('S24-3: 写信任边界——记录型自动生效（source_platform=web）；建议型出确认入口走既有口子；bind_channel 拒绝', async () => {
    ctx = await setupApp()
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const p = await mkProject(ctx.app, cookie, ctx.members.lead.id, '客户C系统')
    const taskId = p.tasks[0].id
    const sid = (await authed(ctx.app, cookie, 'POST', '/api/v1/chat/sessions', {})).body.id

    // 记录型：自动生效 + 回执事件号
    ctx.app.llm = fakeLlm([
      { action: 'query', sql: `SELECT id, name FROM projects WHERE name LIKE '%客户C%'` },
      { action: 'write', kind: 'record_event', payload: { projectId: p.id, eventType: 'risk', summary: '接口联调卡住' } },
    ])
    const rec = await authed(ctx.app, cookie, 'POST', `/api/v1/chat/sessions/${sid}/messages`, { text: '客户C系统登记风险：接口联调卡住' })
    expect(rec.body.assistant.content).toMatch(/已登记.*#\d+/)
    const recEvt = ctx.db.prepare(`SELECT * FROM project_events WHERE nature = 'record' AND summary LIKE '%接口联调%'`).get()
    expect(recEvt.status).toBe('effective')
    expect(recEvt.source_platform).toBe('web')
    expect(recEvt.generated_by).toBe('agent')
    expect(recEvt.speaker_member_id).toBe(1)

    // 建议型：不谎称已改、附事件号与生效/驳回入口；确认走既有口子后任务状态变更
    ctx.app.llm = fakeLlm([
      { action: 'write', kind: 'suggest_event', payload: { targetTaskId: taskId, targetField: 'status', targetValue: 'done', summary: '联调完成' } },
    ])
    const sug = await authed(ctx.app, cookie, 'POST', `/api/v1/chat/sessions/${sid}/messages`, { text: `${taskId} 号任务做完了` })
    const sugMeta = sug.body.assistant.meta
    expect(sug.body.assistant.content).not.toMatch(/已(完成|改)/)
    expect(sug.body.assistant.content).toMatch(/待确认|确认/)
    expect(sugMeta.eventId).toBeTruthy()
    const sugEvt = ctx.db.prepare('SELECT * FROM project_events WHERE id = ?').get(sugMeta.eventId)
    expect(sugEvt.status).toBe('pending')
    expect((await authed(ctx.app, cookie, 'POST', `/api/v1/events/${sugMeta.eventId}/confirm`)).status).toBe(200)
    expect(ctx.db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId).status).toBe('done')

    // bind_channel：web 场景不可用，refused 文案
    ctx.app.llm = fakeLlm([{ action: 'write', kind: 'bind_channel', payload: { projectId: p.id } }])
    const bind = await authed(ctx.app, cookie, 'POST', `/api/v1/chat/sessions/${sid}/messages`, { text: '把这个会话登记为项目群' })
    expect(bind.body.assistant.content).toMatch(/群登记|不可用|拒绝/)
  })

  it('S24-4: 每日限额（chat.quotaPerDay，北京日）——超限礼貌拒绝且入审计', async () => {
    ctx = await setupApp()
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    await authed(ctx.app, cookie, 'PUT', '/api/v1/admin/settings/chat', { quotaPerDay: 1 })
    const sid = (await authed(ctx.app, cookie, 'POST', '/api/v1/chat/sessions', {})).body.id

    ctx.app.llm = fakeLlm([{ action: 'reply', text: '第一句没问题。' }])
    const ok = await authed(ctx.app, cookie, 'POST', `/api/v1/chat/sessions/${sid}/messages`, { text: '第一条' })
    expect(ok.body.assistant.content).toBe('第一句没问题。')

    ctx.app.llm = fakeLlm([{ action: 'reply', text: '不应到达' }])
    const refused = await authed(ctx.app, cookie, 'POST', `/api/v1/chat/sessions/${sid}/messages`, { text: '第二条' })
    expect(refused.status).toBe(200)
    expect(refused.body.assistant.content).toMatch(/额度/)
    expect(refused.body.assistant.meta.result).toBe('refused_quota')
    const rows = ctx.db.prepare(`SELECT result FROM bot_commands WHERE platform = 'web' ORDER BY id`).all()
    expect(rows.map((r) => r.result)).toEqual(['replied', 'refused_quota'])
  })

  it('S24-5: LLM 未配置回明确指引；只读 SQL 护栏与 S20 同源（拒写）', async () => {
    ctx = await setupApp()
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const p = await mkProject(ctx.app, cookie, ctx.members.lead.id, '客户D系统')
    const sid = (await authed(ctx.app, cookie, 'POST', '/api/v1/chat/sessions', {})).body.id

    // 未配置 LLM：不抛错，回指引并落库
    const noLlm = await authed(ctx.app, cookie, 'POST', `/api/v1/chat/sessions/${sid}/messages`, { text: '在吗' })
    expect(noLlm.status).toBe(200)
    expect(noLlm.body.assistant.content).toMatch(/未配置/)
    expect(noLlm.body.assistant.meta.result).toBe('no_llm')

    // 护栏：DELETE 被拒，循环收到失败反馈后正常回复，数据未动
    ctx.app.llm = fakeLlm([
      { action: 'query', sql: 'DELETE FROM projects' },
      { action: 'reply', text: '该操作被拒绝，我不能删除数据。' },
    ])
    const guard = await authed(ctx.app, cookie, 'POST', `/api/v1/chat/sessions/${sid}/messages`, { text: '把项目都删了' })
    expect(guard.body.assistant.content).toBe('该操作被拒绝，我不能删除数据。')
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM projects WHERE id = ?').get(p.id).n).toBe(1)
  })
})
