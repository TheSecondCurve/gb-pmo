import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { setupApp, waitFor } from './helpers.mjs'
import { createProject } from '../engine/projects.js'
import { setSetting } from '../engine/settings.js'
import { upsertChannel } from '../engine/tasks.js'
import { bindProjectWiki } from '../engine/wiki.js'
import { handleBotEvent } from '../brain/bot/command.js'
import { runWriteTool } from '../brain/bot/tools.js'
import { scriptedLlm, makeRecorder, makeMsgFactory, BOT_SECRET } from './bot-kit.mjs'

// PRD S73（v0.85，K69）— 项目群 @机器人触发「生成项目汇总」（S63 机器人入口修订）：
// 写动作 kind=wiki_archive：专题群自动定域 + 权限同 web（牵头人/管理员）+ 复用 startWikiArchive
//（S72 常态守卫/前置校验/幂等替换不变）+ 立即回执「生成中」+ 终态 done（页面链接/消息数）或
// failed（台账中文错误）推回本会话（S64 异步回执模式，推送尽力而为不拖垮台账）。

let ctx
beforeAll(async () => {
  ctx = await setupApp()
  setSetting(ctx.db, 'im.feishu', { appId: 'a', appSecret: 's' }, ctx.members.admin.id)
})
afterAll(() => ctx?.db.close())
const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

const okJson = (data) => ({ ok: true, json: async () => ({ code: 0, data }) })
const sentText = (m) => m.text ?? ''

/** 绑定 wiki 子页 + 专题群（S63 全部前置通过）。nodeToken 固定，断言页面链接用。 */
async function prime(projectId, groupKey) {
  globalThis.fetch = async (rawUrl) => {
    const url = String(rawUrl)
    if (url.includes('tenant_access_token')) return { ok: true, json: async () => ({ code: 0, tenant_access_token: 'tok' }) }
    if (url.includes('/wiki/v2/spaces/get_node')) return okJson({ node: { node_token: 'parenttok', obj_token: 'pdoc', obj_type: 'docx', title: '父页', space_id: 'sp1' } })
    if (url.includes('/wiki/v2/spaces/sp1/nodes')) return okJson({ node: { node_token: 'np_s73', obj_token: 'docs73', obj_type: 'docx', title: '页', space_id: 'sp1' } })
    return okJson({})
  }
  await bindProjectWiki(ctx.db, projectId, { parentNodeToken: 'parenttok', newTitle: `项目${projectId}页` }, ctx.members.admin.id)
  upsertChannel(ctx.db, { platform: 'feishu', groupKey, channelType: 'dedicated', projectId }, ctx.members.admin.id)
}

/**
 * 归档执行阶段 fetch 桩：群历史一条文本消息、文档根块空、插入成功；
 * insertFail 时 docx 插入返回飞书业务错误（code≠0）驱动 run 落 failed。
 */
function stubArchiveRun({ insertFail } = {}) {
  const calls = []
  globalThis.fetch = async (rawUrl, opts = {}) => {
    const url = String(rawUrl)
    calls.push({ url, opts })
    if (url.includes('tenant_access_token')) return { ok: true, json: async () => ({ code: 0, tenant_access_token: 'tok' }) }
    if (url.includes('/im/v1/messages')) {
      return okJson({ items: [{ message_id: 'm1', create_time: String(Math.floor(Date.now() / 1000) - 60), msg_type: 'text', sender: { id: 'fs_zhang', sender_type: 'user' }, body: { content: JSON.stringify({ text: '项目今天启动，一期含北门' }) } }], has_more: false })
    }
    if (url.includes('/docx/v1/documents/') && url.includes('/children')) {
      if ((opts.method ?? 'GET') === 'GET') return okJson({ items: [], has_more: false })
      if (insertFail) return { ok: true, json: async () => ({ code: 1770001, msg: 'invalid param' }) }
      return okJson({ children: [{ block_id: 'gen1' }] })
    }
    return okJson({})
  }
  return calls
}

const runRow = (projectId) => ctx.db.prepare('SELECT * FROM wiki_archive_runs WHERE project_id = ? ORDER BY id DESC LIMIT 1').get(projectId)

const botCtx = (member, chatId, { push } = {}) => ({
  member, evt: { platform: 'feishu', chatId, chatType: 'group' },
  llm: { name: 'fake', complete: async () => '{"notes":[],"quotes":[]}' },
  ...(push !== undefined ? { push } : { push: async () => ({ messageId: null }) }),
})

describe('S73 机器人触发「生成项目汇总」', () => {
  it('S73-1: 牵头人在专题群 @机器人 → 立即回执「生成中」，台账 running→done，终态推送回本群', async () => {
    const p = createProject(ctx.db, { name: 'S73甲项目', typeCode: 'lianmai_365', leadMemberId: ctx.members.lead.id }, ctx.members.admin.id)
    await prime(p.id, 'oc_s73_main')
    stubArchiveRun({})
    const rec = makeRecorder()()
    const factory = makeMsgFactory('om_s73a')
    const s = scriptedLlm(
      '{"action":"write","kind":"wiki_archive","payload":{}}', // ① 动作决策
      '{"notes":["项目启动"],"quotes":[]}', // ② LLM 分块（群消息 1 行 → 1 块）
      '{"highlights":["项目启动"],"quotes":[]}', // ③ 分块合并定稿
    )
    const out = await handleBotEvent(ctx.db, factory.group('fs_zhang', 'oc_s73_main', '@大脑 生成项目汇总', { mentioned: true }), {
      llm: s.llm, send: rec.send, secret: BOT_SECRET,
    })
    expect(out.result).toBe('replied')
    expect(sentText(rec.sent[0])).toContain('生成中')
    await waitFor(() => runRow(p.id)?.status === 'done' && rec.sent.length >= 2, { timeoutMs: 3000 })
    const run = runRow(p.id)
    expect(run.status).toBe('done')
    expect(run.message_count).toBeGreaterThanOrEqual(1)
    // 终态推送：页面链接 + 回读消息数；并落 bot_reply 回执行（定时抽取据此过滤机器人自身消息）
    const final = sentText(rec.sent[1])
    expect(final).toContain('已生成')
    expect(final).toContain(`https://feishu.cn/wiki/np_s73`)
    expect(final).toContain(`${run.message_count} 条`)
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM bot_commands WHERE kind = 'bot_reply' AND intent = 'write:wiki_archive'").get().n).toBeGreaterThanOrEqual(1)
  })

  it('S73-2: failed 推送带台账中文错误；终态推送 send 失败不拖垮台账（尽力而为）', async () => {
    const p = createProject(ctx.db, { name: 'S73乙项目', typeCode: 'lianmai_365', leadMemberId: ctx.members.lead.id }, ctx.members.admin.id)
    await prime(p.id, 'oc_s73_fail')
    stubArchiveRun({ insertFail: true })
    const rec = makeRecorder()()
    const s = scriptedLlm('{"action":"write","kind":"wiki_archive","payload":{}}')
    await handleBotEvent(ctx.db, makeMsgFactory('om_s73b').group('fs_zhang', 'oc_s73_fail', '@大脑 生成项目汇总', { mentioned: true }), {
      llm: s.llm, send: rec.send, secret: BOT_SECRET,
    })
    await waitFor(() => runRow(p.id)?.status === 'failed' && rec.sent.length >= 2, { timeoutMs: 3000 })
    expect(runRow(p.id).error).toContain('1770001')
    expect(sentText(rec.sent[1])).toContain('失败')
    expect(sentText(rec.sent[1])).toContain('1770001')

    // 终态推送 send 抛错 → 台账照常 done，不产生未处理异常
    const p2 = createProject(ctx.db, { name: 'S73丙项目', typeCode: 'lianmai_365', leadMemberId: ctx.members.lead.id }, ctx.members.admin.id)
    await prime(p2.id, 'oc_s73_silent')
    stubArchiveRun({})
    let sent = 0
    const flakySend = async (_m) => { if (++sent > 1) throw new Error('飞书发送失败'); return { messageId: 'bot_s73_ok' } }
    const s2 = scriptedLlm('{"action":"write","kind":"wiki_archive","payload":{}}')
    await handleBotEvent(ctx.db, makeMsgFactory('om_s73c').group('fs_zhang', 'oc_s73_silent', '@大脑 汇总归档一下', { mentioned: true }), {
      llm: s2.llm, send: flakySend, secret: BOT_SECRET,
    })
    await waitFor(() => runRow(p2.id)?.status === 'done', { timeoutMs: 3000 })
    expect(runRow(p2.id).status).toBe('done')
  })

  it('S73-3: 非牵头人非管理员拒绝；未定域项目给引导文案', async () => {
    const p = createProject(ctx.db, { name: 'S73丁项目', typeCode: 'lianmai_365', leadMemberId: ctx.members.lead.id }, ctx.members.admin.id)
    await prime(p.id, 'oc_s73_perm')
    // 李四（普通成员）触发 → 拒绝（与 web 路由 403 同口径）
    const denied = await runWriteTool(ctx.db, { kind: 'wiki_archive', payload: {} }, botCtx(ctx.members.dev, 'oc_s73_perm'))
    expect(denied.type).toBe('refused')
    expect(denied.text).toMatch(/仅系统管理员或项目牵头人/)
    // 未绑定群且未点名 projectId → 引导（去专题群或 web 按钮）
    const lost = await runWriteTool(ctx.db, { kind: 'wiki_archive', payload: {} }, botCtx(ctx.members.lead, 'oc_unbound_s73'))
    expect(lost.type).toBe('refused')
    expect(lost.text).toMatch(/专题群|项目详情页/)
  })

  it('S73-4: 前置校验中文文案原样透传（常态守卫/未绑知识页/运行中），不落台账', async () => {
    // 常态项目（S72 守卫经机器人入口同样生效）
    const routine = createProject(ctx.db, { name: 'S73常态项目', typeCode: 'lianmai_365', leadMemberId: ctx.members.lead.id, kind: 'routine' }, ctx.members.admin.id)
    await prime(routine.id, 'oc_s73_routine')
    const r1 = await runWriteTool(ctx.db, { kind: 'wiki_archive', payload: {} }, botCtx(ctx.members.lead, 'oc_s73_routine'))
    expect(r1.type).toBe('refused')
    expect(r1.text).toContain('常态项目')
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM wiki_archive_runs WHERE project_id = ?').get(routine.id).n).toBe(0)

    // 交付项目未绑知识页
    const bare = createProject(ctx.db, { name: 'S73未绑页项目', typeCode: 'lianmai_365', leadMemberId: ctx.members.lead.id }, ctx.members.admin.id)
    upsertChannel(ctx.db, { platform: 'feishu', groupKey: 'oc_s73_bare', channelType: 'dedicated', projectId: bare.id }, ctx.members.admin.id)
    const r2 = await runWriteTool(ctx.db, { kind: 'wiki_archive', payload: {} }, botCtx(ctx.members.lead, 'oc_s73_bare'))
    expect(r2.type).toBe('refused')
    expect(r2.text).toContain('知识库')

    // 已有运行中汇总 → 409 语义文案
    const busy = createProject(ctx.db, { name: 'S73运行中项目', typeCode: 'lianmai_365', leadMemberId: ctx.members.lead.id }, ctx.members.admin.id)
    await prime(busy.id, 'oc_s73_busy')
    ctx.db.prepare("INSERT INTO wiki_archive_runs (project_id, status, stage, created_at) VALUES (?, 'running', 'fetch', ?)").run(busy.id, Date.now())
    const r3 = await runWriteTool(ctx.db, { kind: 'wiki_archive', payload: {} }, botCtx(ctx.members.lead, 'oc_s73_busy'))
    expect(r3.type).toBe('refused')
    expect(r3.text).toContain('正在运行')
  })

  it('S73-5: 无 push 能力的会话（web AI 助手）→ 拒绝并指引 web 按钮（与 init_assign 同口径）', async () => {
    const out = await runWriteTool(ctx.db, { kind: 'wiki_archive', payload: {} }, {
      member: ctx.members.lead, evt: { platform: 'web', chatType: 'p2p', chatId: 'web_s1' },
      llm: { name: 'fake', complete: async () => '{}' },
    })
    expect(out.type).toBe('refused')
    expect(out.text).toContain('项目详情页')
  })
})
