import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { setupApp } from './helpers.mjs'
import { BOT_SECRET as SECRET, scriptedLlm, makeRecorder, makeMsgFactory } from './bot-kit.mjs'
import { handleBotEvent } from '../brain/bot/command.js'
import { getProjectWiki } from '../engine/wiki.js'
import { setSetting } from '../engine/settings.js'

// PRD S77（v0.90，K77）— 私聊快速立项从无到有：机器人 createChat 建群（群名=项目名、群主）
// → members API 拉发起人+默认成员（去重；未绑飞书跳过点名）→ S70 链（建项目/绑新群/默认父页建知识页）
// → 回执在私聊。失败语义：项目先建，建群/拉人失败不回滚、如实回执并指路。群内 /init 行为不变。

let ctx
const { p2p, group } = makeMsgFactory('om_s77')
const PARENT_TOKEN = 'RPpBwqXzOiMgSZkEgRCcoSN8nef'
const DEFAULT_PARENT = `https://ghy685ffir.feishu.cn/wiki/${PARENT_TOKEN}`

beforeAll(async () => {
  ctx = await setupApp()
  setSetting(ctx.db, 'im.feishu', { appId: 'a', appSecret: 's', botEnabled: true }, ctx.members.admin.id)
})
afterAll(() => ctx?.db?.close())
const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

const okJson = (data) => ({ ok: true, json: async () => ({ code: 0, data }) })
const sentText = (rec) => {
  const m = rec.sent[0]
  if (!m) return ''
  if (m.text) return m.text
  if (m.post) return (m.post.zh_cn?.content || []).flat().map((r) => r?.text || '').join('')
  return ''
}

/**
 * 私聊快速立项全链桩：建群 + 拉人 + 默认父页建子页，全部捕获载荷。
 * memberResult 驱动拉人失败（invalid_id_list）；createFail 驱动建群失败。
 */
function stubDmChain({ memberResult, createFail, chatId = 'oc_s77_new' } = {}) {
  const created = [] // 建群载荷 { name }
  const invites = [] // 拉人载荷 { idList }
  const calls = []
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url)
    calls.push({ url: u, method: opts.method ?? 'GET' })
    if (u.includes('tenant_access_token')) return { ok: true, json: async () => ({ code: 0, tenant_access_token: 'tok' }) }
    const isChatCreate = u.includes('/im/v1/chats') && !/\/chats\/[^/]+/.test(u.slice(u.indexOf('/im/v1/chats'))) && (opts.method ?? 'GET') === 'POST'
    if (isChatCreate) {
      created.push(JSON.parse(opts.body || '{}'))
      if (createFail) return { ok: true, json: async () => ({ code: createFail, msg: 'create denied' }) }
      return okJson({ chat_id: chatId })
    }
    if (u.includes('/im/v1/chats/') && u.includes('/members') && opts.method === 'POST') {
      invites.push(JSON.parse(opts.body || '{}'))
      return okJson(memberResult ?? { invalid_id_list: [], not_existed_id_list: [] })
    }
    if (u.includes('/wiki/v2/spaces/get_node')) return okJson({ node: { node_token: PARENT_TOKEN, obj_token: 'pdoc', obj_type: 'docx', title: '默认父页面', space_id: 'sp_root' } })
    if (u.includes('/wiki/v2/spaces/sp_root/nodes') && opts.method === 'POST') {
      return okJson({ node: { node_token: 'np_s77', obj_token: 'docs77', obj_type: 'docx', title: JSON.parse(opts.body || '{}').title, space_id: 'sp_root' } })
    }
    return okJson({})
  }
  return { created, invites, calls }
}

/** 私聊触发快速立项（write quick_create_project，LLM 脚本化）。 */
async function dmQuickCreate(text, payload = '{}') {
  const rec = makeRecorder()()
  const s = scriptedLlm(`{"action":"write","kind":"quick_create_project","payload":${payload}}`)
  const out = await handleBotEvent(ctx.db, p2p('fs_zhang', text), { llm: s.llm, send: rec.send, secret: SECRET })
  return { out, rec }
}

const projByName = (name) => ctx.db.prepare('SELECT * FROM projects WHERE name = ?').get(name)
const channelOf = (groupKey) => ctx.db.prepare('SELECT * FROM channels WHERE group_key = ?').get(groupKey)

describe('S77 私聊快速立项从无到有', () => {
  it('S77-1: 私聊一句话——建群（群名=项目名）→ 拉发起人+默认成员（去重、未绑飞书点名跳过）→ 项目+新群渠道+知识页全链，回执含建群拉人与页面链接', async () => {
    // 默认成员：张三(lead, fs_zhang=发起人, 去重)、李四(dev, fs_li)、王五(key, 无 feishuId → 跳过点名)
    setSetting(ctx.db, 'projects', { quickCreateTypeCode: 'lianmai_365', quickCreateDefaultMembers: [ctx.members.lead.id, ctx.members.dev.id, ctx.members.key.id] }, ctx.members.admin.id)
    setSetting(ctx.db, 'wiki', { defaultParentUrl: DEFAULT_PARENT }, ctx.members.admin.id)
    const { created, invites } = stubDmChain({})
    const { out, rec } = await dmQuickCreate('快速立项 S77下午茶', '{"name":"S77下午茶"}')

    expect(out.result).toBe('replied')
    expect(created).toEqual([{ name: 'S77下午茶', chat_mode: 'group', user_id_type: 'open_id' }]) // 群名=项目名
    expect(invites).toEqual([{ id_list: ['fs_zhang', 'fs_li'] }]) // 发起人与默认成员去重；未绑飞书的王五跳过
    const p = projByName('S77下午茶')
    expect(p).toBeTruthy()
    expect(p.lead_member_id).toBe(ctx.members.lead.id) // 牵头人=发起人
    const ch = channelOf('oc_s77_new')
    expect(ch?.channel_type).toBe('dedicated')
    expect(ch?.project_id).toBe(p.id)
    expect(getProjectWiki(ctx.db, p.id)?.nodeToken).toBe('np_s77')
    const text = sentText(rec)
    expect(text).toContain('新群「S77下午茶」已建')
    expect(text).toContain('已拉入 2/2')
    expect(text).toContain('王五') // 未绑飞书默认成员点名跳过
    expect(text).toContain('feishu.cn/wiki/np_s77')
    expect(text).toContain('专题渠道')
  })

  it('S77-2: projects 设置校验——quickCreateDefaultMembers 须为整数成员 id 数组（非法形状 400）；合法保存可读回', async () => {
    setSetting(ctx.db, 'projects', { quickCreateDefaultMembers: [ctx.members.dev.id] }, ctx.members.admin.id)
    const read = ctx.db.prepare("SELECT value FROM settings WHERE key = 'projects'").get()
    expect(JSON.parse(read.value).quickCreateDefaultMembers).toEqual([ctx.members.dev.id])
    expect(() => setSetting(ctx.db, 'projects', { quickCreateDefaultMembers: ['x'] }, ctx.members.admin.id)).toThrow(/整数/)
    expect(() => setSetting(ctx.db, 'projects', { quickCreateDefaultMembers: 'x' }, ctx.members.admin.id)).toThrow(/数组/)
  })

  it('S77-3: 群内 /init 行为不变——不建群不拉人（零 /im/v1/chats 写请求）、回执文案不变', async () => {
    setSetting(ctx.db, 'wiki', { defaultParentUrl: DEFAULT_PARENT }, ctx.members.admin.id)
    setSetting(ctx.db, 'projects', { quickCreateTypeCode: 'lianmai_365', quickCreateDefaultMembers: [ctx.members.dev.id] }, ctx.members.admin.id)
    const { calls } = stubDmChain({})
    // 群已存在（无绑定），群内触发
    const rec = makeRecorder()()
    const s = scriptedLlm('{"action":"write","kind":"quick_create_project","payload":{}}')
    const out = await handleBotEvent(ctx.db, group('fs_zhang', 'oc_s77_grp', '@大脑 快速立项', { mentioned: true, chatTitle: 'S77群内项目' }), { llm: s.llm, send: rec.send, secret: SECRET })
    expect(out.result).toBe('replied')
    expect(calls.some((c) => c.url.includes('/im/v1/chats') && c.method === 'POST')).toBe(false) // 不建群不拉人
    const p = projByName('S77群内项目')
    expect(channelOf('oc_s77_grp')?.project_id).toBe(p.id) // 绑的是既有群
    const text = sentText(rec)
    expect(text).toContain('本群已绑定为项目专题渠道') // 群内回执文案不变
    expect(text).not.toContain('新群')
  })

  it('S77-3: 私聊缺名称明确引导；建群失败不回滚项目、如实回执并指路群登记', async () => {
    // ① 缺名称：私聊无群名可借，明确引导（不建群）
    const { created } = stubDmChain({})
    const noName = await dmQuickCreate('快速立项', '{}')
    expect(noName.out.result).toBe('replied') // 引导式拒绝：回执即引导文案
    expect(sentText(noName.rec)).toContain('项目名')
    expect(created).toHaveLength(0)

    // ② 建群失败：项目照建（不回滚），不绑渠道，回执指路群登记
    stubDmChain({ createFail: 232024 })
    const { rec } = await dmQuickCreate('快速立项 S77建群失败项目', '{"name":"S77建群失败项目"}')
    const p = projByName('S77建群失败项目')
    expect(p?.status).toBe('active') // 项目不回滚
    expect(channelOf('oc_s77_fail')).toBeFalsy() // 未绑渠道
    const text = sentText(rec)
    expect(text).toContain('建群失败')
    expect(text).toContain('登记')

    // ③ 拉人个别失败：点名不阻断，渠道照绑
    stubDmChain({ memberResult: { invalid_id_list: ['fs_li'], not_existed_id_list: [] }, chatId: 'oc_s77_partial' })
    setSetting(ctx.db, 'projects', { quickCreateTypeCode: 'lianmai_365', quickCreateDefaultMembers: [ctx.members.dev.id] }, ctx.members.admin.id)
    const r3 = await dmQuickCreate('快速立项 S77拉人失败项目', '{"name":"S77拉人失败项目"}')
    const p3 = projByName('S77拉人失败项目')
    expect(p3?.status).toBe('active')
    expect(channelOf('oc_s77_partial')?.project_id).toBe(p3.id)
    expect(sentText(r3.rec)).toContain('李四') // 拉入失败点名
  })
})
