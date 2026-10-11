import { describe, it, expect, afterAll, afterEach } from 'vitest'
import { setupDb, seedMembers } from './helpers.mjs'
import { createProject } from '../engine/projects.js'
import { setSetting, getSetting } from '../engine/settings.js'
import { getProjectWiki, getDefaultParentToken } from '../engine/wiki.js'
import { confirmProposal } from '../engine/proposals.js'

// PRD S62（v0.67，K47）— 知识库默认父页面 + 卡片确认新建子页 + 回执带链接：
// 默认父页面存 settings（migration 0028 落库，管理员可改）；项目未绑定时记录经确认卡
// 在默认父页面下新建子页+绑定+写入（复用 proposals 状态机）；记录成功回执带页面链接。

let db
let members
afterAll(() => db?.close())
const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

const DEFAULT_PARENT = 'https://ghy685ffir.feishu.cn/wiki/RPpBwqXzOiMgSZkEgRCcoSN8nef'

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

function freshProject(name) {
  return createProject(db, { name, typeCode: 'lianmai_365', leadMemberId: members.lead.id }, members.admin.id)
}

describe('S62 默认父页面 + 丝滑记录', () => {
  it('S62-1: 默认父页面经 migration 落库（settings.wiki.defaultParentUrl），管理员可改', () => {
    ;({ db } = setupDb())
    members = seedMembers(db)
    setSetting(db, 'im.feishu', { appId: 'a', appSecret: 's' }, members.admin.id)
    // migration 0028 落的初始值
    expect(getSetting(db, 'wiki').defaultParentUrl).toBe(DEFAULT_PARENT)
    expect(getDefaultParentToken(db)).toBe('RPpBwqXzOiMgSZkEgRCcoSN8nef')
    // 管理员改后生效
    setSetting(db, 'wiki', { defaultParentUrl: 'https://x.feishu.cn/wiki/newparent123' }, members.admin.id)
    expect(getDefaultParentToken(db)).toBe('newparent123')
    // 改回默认供后续用例
    setSetting(db, 'wiki', { defaultParentUrl: DEFAULT_PARENT }, members.admin.id)
  })

  it('S62-2: 未绑定+有默认父页面 → record_wiki 出确认卡（proposal 落库，payload 带原文）', async () => {
    const p = freshProject('丝滑项目')
    const { runWriteTool } = await import('../brain/bot/tools.js')
    const r = await runWriteTool(db, {
      kind: 'record_wiki',
      payload: { projectId: p.id, eventType: 'decision', summary: '一期范围已定' },
    }, { member: members.dev, evt: { chatType: 'group', chatId: 'oc_x', ts: Date.now(), text: '记到文档里：一期范围已定' } })
    // 出确认卡而非拒绝
    expect(r.type).toBe('card')
    expect(r.cardKind).toBe('propose')
    expect(r.kind).toBe('record_wiki_newpage')
    // proposal 落库，payload 带原文与项目名（新建子页标题缺省=项目名）
    const prop = db.prepare('SELECT * FROM proposals WHERE id = ?').get(r.proposalId)
    expect(prop.kind).toBe('record_wiki_newpage')
    expect(prop.status).toBe('pending')
    const payload = JSON.parse(prop.payload)
    expect(payload.summary).toBe('一期范围已定')
    expect(payload.newTitle).toBe('丝滑项目')
    expect(payload.projectId).toBe(p.id)
  })

  it('S62-3: 确认后一步完成建页+绑定+写入，回执带链接', async () => {
    const p = freshProject('一步到位项目')
    const { runWriteTool } = await import('../brain/bot/tools.js')
    const r = await runWriteTool(db, {
      kind: 'record_wiki',
      payload: { projectId: p.id, eventType: 'progress', summary: '原型评审通过，含三条修改意见' },
    }, { member: members.dev, evt: { chatType: 'group', chatId: 'oc_x', ts: Date.now(), text: '记一下：原型评审通过，含三条修改意见' } })
    expect(r.type).toBe('card')
    // 确认：mock 默认父页面 get_node + create_node + appendDocBlocks
    const calls = stubFetch([
      ['/wiki/v2/spaces/get_node', () => okJson({ node: { node_token: 'RPpBwqXzOiMgSZkEgRCcoSN8nef', obj_token: 'parentdoc', obj_type: 'docx', title: '默认父页面', space_id: 'sp_root' } })],
      ['/wiki/v2/spaces/sp_root/nodes', () => okJson({ node: { node_token: 'newpage1', obj_token: 'newdoc1', obj_type: 'docx', title: '一步到位项目', space_id: 'sp_root' } })],
      ['/docx/v1/documents/newdoc1/blocks', () => okJson({})],
    ])
    const { result } = await confirmProposal(db, r.proposalId, members.lead.id)
    // 建子页用父节点的 spaceId
    const create = calls.find((c) => c.url.includes('/wiki/v2/spaces/sp_root/nodes') && c.opts?.method === 'POST')
    expect(create).toBeTruthy()
    expect(JSON.parse(create.opts.body).title).toBe('一步到位项目')
    // 绑定落库
    expect(getProjectWiki(db, p.id)?.nodeToken).toBe('newpage1')
    // 写入追加到新建页（原文）
    const append = calls.find((c) => c.url.includes('/docx/v1/documents/newdoc1/blocks/newdoc1/children'))
    expect(JSON.parse(append.opts.body).children[1].text.elements[0].text_run.content).toBe('原型评审通过，含三条修改意见')
    // apply 返回带链接
    expect(result.url).toBe('https://feishu.cn/wiki/newpage1')
  })

  it('S62-4: 未绑定+无默认父页面 → 维持引导式拒绝', async () => {
    const p = freshProject('无默认项目')
    setSetting(db, 'wiki', { defaultParentUrl: '' }, members.admin.id) // 清空默认父页面
    const { runWriteTool } = await import('../brain/bot/tools.js')
    const r = await runWriteTool(db, {
      kind: 'record_wiki', payload: { projectId: p.id, eventType: 'progress', summary: 'x' },
    }, { member: members.dev, evt: { chatType: 'group', chatId: 'oc_x', ts: Date.now(), text: '记一下：x' } })
    expect(r.type).toBe('refused')
    expect(r.text).toContain('未绑定知识库')
    expect(r.text).toContain('绑定方式')
    // 还原默认父页面
    setSetting(db, 'wiki', { defaultParentUrl: DEFAULT_PARENT }, members.admin.id)
  })

  it('S62-5: 已绑定时 record_wiki 成功回执带页面链接', async () => {
    const p = freshProject('带链接项目')
    stubFetch([['/wiki/v2/spaces/get_node', () => okJson({ node: { node_token: 'bound1', obj_token: 'bounddoc', obj_type: 'docx', title: '带链接项目页', space_id: 'sp1' } })]])
    const { bindProjectWiki } = await import('../engine/wiki.js')
    await bindProjectWiki(db, p.id, { wikiUrl: 'https://x.feishu.cn/wiki/bound1' }, members.admin.id)
    stubFetch([['/docx/v1/documents/bounddoc/blocks', () => okJson({})]])
    const { runWriteTool } = await import('../brain/bot/tools.js')
    const r = await runWriteTool(db, {
      kind: 'record_wiki', payload: { projectId: p.id, eventType: 'progress', summary: '一期范围已定' },
    }, { member: members.dev, evt: { chatType: 'group', chatId: 'oc_x', ts: Date.now(), text: '记一下：一期范围已定' } })
    expect(r.type).toBe('receipt')
    expect(r.text).toContain('已记到')
    expect(r.text).toContain('https://feishu.cn/wiki/bound1') // 页面链接
  })
})
