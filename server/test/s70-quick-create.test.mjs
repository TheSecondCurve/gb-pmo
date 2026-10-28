import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { setupApp, loginCookie, authed } from './helpers.mjs'
import { BOT_SECRET as SECRET, scriptedLlm, makeRecorder, makeMsgFactory } from './bot-kit.mjs'
import { handleBotEvent } from '../brain/bot/command.js'
import { runWriteTool } from '../brain/bot/tools.js'
import { createProject } from '../engine/projects.js'
import { upsertChannel } from '../engine/tasks.js'
import { getProjectWiki } from '../engine/wiki.js'
import { getSetting, setSetting } from '../engine/settings.js'

// PRD S70（v0.82，K66）— 新群快速立项与知识页默认父页回落：
// A. bind_wiki 只给 newTitle 时自动回落 wiki.defaultParentUrl 建页绑定（明确指令直生效，K25）；
// B. 新群 /init [类型码]（零 LLM 斜杠）/ write quick_create_project：项目名=群名、牵头人=发起人、
//    类型=参数→projects.quickCreateTypeCode→拒绝列候选；一条链 建项目→绑群→默认父页建知识页（best-effort）。

let ctx
const recorder = makeRecorder()
const { p2p, group } = makeMsgFactory('om_s70')
const PARENT_TOKEN = 'RPpBwqXzOiMgSZkEgRCcoSN8nef'
const DEFAULT_PARENT = `https://ghy685ffir.feishu.cn/wiki/${PARENT_TOKEN}`

beforeAll(async () => {
  ctx = await setupApp()
  setSetting(ctx.db, 'im.feishu', { appId: 'a', appSecret: 's', botEnabled: true }, ctx.members.admin.id)
})
afterAll(() => ctx?.db.close())
const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

function stubFetch(handlers, calls = []) {
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts })
    if (url.includes('tenant_access_token')) return { ok: true, json: async () => ({ code: 0, tenant_access_token: 'tok' }) }
    for (const [match, responder] of handlers) {
      if (url.includes(match)) return responder(url, opts)
    }
    return { ok: true, json: async () => ({ code: 0, data: {} }) }
  }
  return calls
}
const okJson = (data) => ({ ok: true, json: async () => ({ code: 0, data }) })

/** 出站消息取纯文本（多行回执走富文本 post，拍平取字符）。 */
const sentText = (rec) => {
  const m = rec.sent[0]
  if (!m) return ''
  if (m.text) return m.text
  if (m.post) return (m.post.zh_cn?.content || []).flat().map((r) => r?.text || '').join('')
  return ''
}

/** 默认父页下建子页的飞书端点三件套（get_node 父页 + create 子页，子页标题回显请求值）。 */
function stubWikiCreate(calls = []) {
  return stubFetch([
    ['/wiki/v2/spaces/get_node', () => okJson({ node: { node_token: PARENT_TOKEN, obj_token: 'pdoc', obj_type: 'docx', title: '默认父页面', space_id: 'sp_root' } })],
    ['/wiki/v2/spaces/sp_root/nodes', (url, opts) => okJson({ node: { node_token: `newpage_${calls.length}`, obj_token: `newdoc_${calls.length}`, obj_type: 'docx', title: JSON.parse(opts.body || '{}').title || '新建页', space_id: 'sp_root' } })],
  ], calls)
}

const projByName = (name) => ctx.db.prepare('SELECT * FROM projects WHERE name = ?').get(name)
const channelOf = (groupKey) => ctx.db.prepare('SELECT * FROM channels WHERE platform = ? AND group_key = ?').get('feishu', groupKey)

describe('S70 新群快速立项与知识页默认父页回落', () => {
  it('S70-1: bind_wiki 只给 newTitle → 回落默认父页建页绑定；未配默认父页 → 引导式拒绝', async () => {
    // migration 0028 落的默认父页在此测试库存在
    expect(getSetting(ctx.db, 'wiki').defaultParentUrl).toBe(DEFAULT_PARENT)
    const p = createProject(ctx.db, { name: '回落项目', typeCode: 'lianmai_365', leadMemberId: ctx.members.lead.id }, ctx.members.admin.id)
    const calls = stubWikiCreate()
    const r = await runWriteTool(ctx.db, {
      kind: 'bind_wiki', payload: { projectId: p.id, newTitle: '回落子页' },
    }, { member: ctx.members.admin, evt: { chatType: 'group', chatId: 'oc_s70_1', ts: Date.now(), text: '新建一个项目飞书页' } })
    expect(r.type).toBe('receipt')
    expect(r.text).toContain('默认父页面')
    expect(r.text).toContain('回落子页')
    // 建子页用默认父页的 spaceId，绑定落库
    const create = calls.find((c) => c.url.includes('/wiki/v2/spaces/sp_root/nodes') && c.opts?.method === 'POST')
    expect(create).toBeTruthy()
    expect(JSON.parse(create.opts.body).title).toBe('回落子页')
    expect(getProjectWiki(ctx.db, p.id)).toBeTruthy()

    // 未配默认父页 → 引导式拒绝（明示父页链接或配置默认父页面两条路）
    setSetting(ctx.db, 'wiki', { defaultParentUrl: '' }, ctx.members.admin.id)
    const p2 = createProject(ctx.db, { name: '回落项目2', typeCode: 'lianmai_365', leadMemberId: ctx.members.lead.id }, ctx.members.admin.id)
    const r2 = await runWriteTool(ctx.db, {
      kind: 'bind_wiki', payload: { projectId: p2.id, newTitle: '回落子页2' },
    }, { member: ctx.members.admin, evt: { chatType: 'group', chatId: 'oc_s70_1b', ts: Date.now(), text: '新建一个项目飞书页' } })
    expect(r2.type).toBe('refused')
    expect(r2.text).toContain('父页面')
    setSetting(ctx.db, 'wiki', { defaultParentUrl: DEFAULT_PARENT }, ctx.members.admin.id) // 还原
  })

  it('S70-2: 新群 /init lianmai_365 → 群名立项+模板任务+绑群+默认父页建知识页，一条回执', async () => {
    const calls = stubWikiCreate()
    const rec = recorder()
    const out = await handleBotEvent(ctx.db, group('fs_zhang', 'oc_s70_2', '/init lianmai_365', { chatTitle: '365连麦·测试专场' }), { send: rec.send, secret: SECRET })
    expect(out.result).toBe('replied')
    const text = sentText(rec)
    // 项目名=群名、牵头人=发起人
    const proj = projByName('365连麦·测试专场')
    expect(proj).toBeTruthy()
    expect(proj.lead_member_id).toBe(ctx.members.lead.id)
    expect(text).toContain(`#${proj.id}`)
    // 任务按类型清单实例化，回执带任务数
    const taskCount = ctx.db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE project_id = ?').get(proj.id).n
    expect(taskCount).toBeGreaterThan(0)
    expect(text).toMatch(/实例化 \d+ 项/)
    // 本群绑定为专题渠道（cursor=当前时刻，群名回填）
    const ch = channelOf('oc_s70_2')
    expect(ch.channel_type).toBe('dedicated')
    expect(ch.project_id).toBe(proj.id)
    expect(ch.name).toBe('365连麦·测试专场')
    expect(text).toContain('专题渠道')
    // 默认父页下建知识页并绑定，回执带链接（host 取默认父页 URL）
    expect(getProjectWiki(ctx.db, proj.id)).toBeTruthy()
    const create = calls.find((c) => c.url.includes('/wiki/v2/spaces/sp_root/nodes') && c.opts?.method === 'POST')
    expect(JSON.parse(create.opts.body).title).toBe('365连麦·测试专场')
    expect(text).toContain(`https://ghy685ffir.feishu.cn/wiki/${getProjectWiki(ctx.db, proj.id).nodeToken}`)
    // 零 LLM：回执即时（未注入 llm，若走 LLM 会因未配置被拒）
  })

  it('S70-3: 类型无法解析 → 拒绝并列出全部可用类型，不建项目', async () => {
    expect(getSetting(ctx.db, 'projects').quickCreateTypeCode).toBe('custom') // 缺省=custom（自由创建，0037 启用）
    setSetting(ctx.db, 'projects', { quickCreateTypeCode: '' }, ctx.members.admin.id) // 管理员清空默认后才走拒绝
    const rec = recorder()
    let out = await handleBotEvent(ctx.db, group('fs_zhang', 'oc_s70_3a', '/init', { chatTitle: '无类型群' }), { send: rec.send, secret: SECRET })
    expect(out.result).toBe('replied')
    let text = rec.sent.at(-1).text
    expect(text).toContain('lianmai_365')
    expect(text).toContain('类型')
    expect(projByName('无类型群')).toBeUndefined()
    // 类型码不存在：同样拒绝并列候选
    out = await handleBotEvent(ctx.db, group('fs_zhang', 'oc_s70_3b', '/init bogus_type', { chatTitle: '坏类型群' }), { send: rec.send, secret: SECRET })
    expect(out.result).toBe('replied')
    text = rec.sent.at(-1).text
    expect(text).toContain('consulting_1v1')
    expect(projByName('坏类型群')).toBeUndefined()
    setSetting(ctx.db, 'projects', { quickCreateTypeCode: 'custom' }, ctx.members.admin.id) // 还原默认
  })

  it('S70-4: 守卫——私聊不可用/已绑群拒绝/未绑定成员引导/群名不可得报错，无部分写入', async () => {
    const rec = recorder()
    // 私聊
    await handleBotEvent(ctx.db, p2p('fs_zhang', '/init'), { send: rec.send, secret: SECRET })
    expect(rec.sent.at(-1).text).toContain('群聊')
    // 群已是专题渠道：拒绝并告知已绑项目
    const p0 = createProject(ctx.db, { name: '已绑项目', typeCode: 'lianmai_365', leadMemberId: ctx.members.lead.id }, ctx.members.admin.id)
    upsertChannel(ctx.db, { platform: 'feishu', groupKey: 'oc_s70_busy', name: '繁忙群', channelType: 'dedicated', projectId: p0.id }, ctx.members.admin.id)
    await handleBotEvent(ctx.db, group('fs_zhang', 'oc_s70_busy', '/init lianmai_365', { chatTitle: '繁忙群' }), { send: rec.send, secret: SECRET })
    expect(rec.sent.at(-1).text).toContain('已绑项目')
    // 未绑定飞书账号的发送者：绑定引导（不立项）
    await handleBotEvent(ctx.db, group('fs_nobody', 'oc_s70_4c', '/init lianmai_365', { chatTitle: '陌生人群' }), { send: rec.send, secret: SECRET })
    expect(rec.sent.at(-1).text).toContain('绑定')
    expect(projByName('陌生人群')).toBeUndefined()
    // 群名不可得（chatTitle 缺失 + getChat 失败）：明确报错，不建项目
    stubFetch([['/im/v1/chats/', () => ({ ok: false, json: async () => ({ code: 1, msg: 'no permission' }) })]])
    await handleBotEvent(ctx.db, group('fs_zhang', 'oc_s70_4d', '/init lianmai_365'), { send: rec.send, secret: SECRET })
    expect(rec.sent.at(-1).text).toContain('群名')
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM channels WHERE group_key = ?').get('oc_s70_4d').n).toBe(0)
  })

  it('S70-5: 知识页 best-effort——未配默认父页时立项与绑群照常，回执单列原因', async () => {
    setSetting(ctx.db, 'wiki', { defaultParentUrl: DEFAULT_PARENT }, ctx.members.admin.id)
    setSetting(ctx.db, 'wiki', { defaultParentUrl: '' }, ctx.members.admin.id)
    const rec = recorder()
    const out = await handleBotEvent(ctx.db, group('fs_zhang', 'oc_s70_5', '/init lianmai_365', { chatTitle: '无知识页群' }), { send: rec.send, secret: SECRET })
    expect(out.result).toBe('replied')
    const proj = projByName('无知识页群')
    expect(proj).toBeTruthy() // 立项不受阻
    expect(channelOf('oc_s70_5')?.project_id).toBe(proj.id) // 绑群不受阻
    expect(sentText(rec)).toContain('知识页未建')
    expect(getProjectWiki(ctx.db, proj.id)).toBeNull()
    setSetting(ctx.db, 'wiki', { defaultParentUrl: DEFAULT_PARENT }, ctx.members.admin.id) // 还原
  })

  it('S70-6: 未登记群自然语言「建个项目」→ write quick_create_project 同一条链', async () => {
    setSetting(ctx.db, 'wiki', { defaultParentUrl: DEFAULT_PARENT }, ctx.members.admin.id)
    stubWikiCreate()
    const { llm } = scriptedLlm(JSON.stringify({ action: 'write', kind: 'quick_create_project', payload: { typeCode: 'lianmai_365' } }))
    const rec = recorder()
    const out = await handleBotEvent(ctx.db, group('fs_li', 'oc_s70_6', '快速立项', { chatTitle: '自然语言立项群' }), { llm, send: rec.send, secret: SECRET })
    expect(out.result).toBe('replied')
    const proj = projByName('自然语言立项群')
    expect(proj).toBeTruthy()
    expect(proj.lead_member_id).toBe(ctx.members.dev.id) // 发起人=牵头人
    expect(channelOf('oc_s70_6')?.project_id).toBe(proj.id)
    expect(getProjectWiki(ctx.db, proj.id)).toBeTruthy()
    expect(sentText(rec)).toContain('快速立项')
  })

  it('S70-7: projects.quickCreateTypeCode 配置可保存回读，全局默认兜底 /init 无参', async () => {
    // 深合并默认值：缺省 custom（自由创建）
    expect(getSetting(ctx.db, 'projects').quickCreateTypeCode).toBe('custom')
    // API 面：管理员保存回读
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const put = await authed(ctx.app, cookie, 'PUT', '/api/v1/admin/settings/projects', { quickCreateTypeCode: 'afternoon_tea' })
    expect(put.status).toBe(200)
    expect(getSetting(ctx.db, 'projects').quickCreateTypeCode).toBe('afternoon_tea')
    // /init 无参 → 全局默认生效
    stubWikiCreate()
    const rec = recorder()
    await handleBotEvent(ctx.db, group('fs_zhang', 'oc_s70_7', '/init', { chatTitle: '默认类型群' }), { send: rec.send, secret: SECRET })
    const proj = projByName('默认类型群')
    expect(proj).toBeTruthy()
    const type = ctx.db.prepare('SELECT t.name FROM project_types t JOIN projects p ON p.project_type_id = t.id WHERE p.id = ?').get(proj.id)
    expect(type.name).toBe('商业下午茶')
    setSetting(ctx.db, 'projects', { quickCreateTypeCode: 'custom' }, ctx.members.admin.id) // 还原默认
  })

  it('S70-8: chatTitle 缺失时经连接器 getChat 回拉群名立项', async () => {
    stubFetch([
      ['/im/v1/chats/oc_s70_8', () => okJson({ name: '回拉群名专场', external: false })],
      ['/wiki/v2/spaces/get_node', () => okJson({ node: { node_token: PARENT_TOKEN, obj_token: 'pdoc', obj_type: 'docx', title: '默认父页面', space_id: 'sp_root' } })],
      ['/wiki/v2/spaces/sp_root/nodes', () => okJson({ node: { node_token: 's70_8_page', obj_token: 's70_8_doc', obj_type: 'docx', title: '回拉群名专场', space_id: 'sp_root' } })],
    ])
    const rec = recorder()
    const out = await handleBotEvent(ctx.db, group('fs_zhang', 'oc_s70_8', '/init lianmai_365'), { send: rec.send, secret: SECRET })
    expect(out.result).toBe('replied')
    const proj = projByName('回拉群名专场')
    expect(proj).toBeTruthy()
    expect(channelOf('oc_s70_8')?.name).toBe('回拉群名专场') // 渠道名同样回填
  })
})
