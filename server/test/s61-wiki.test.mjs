import { describe, it, expect, afterAll, afterEach } from 'vitest'
import { setupDb, seedMembers } from './helpers.mjs'
import { createProject } from '../engine/projects.js'
import { setSetting } from '../engine/settings.js'
import { parseWikiNodeToken, getProjectWiki, bindProjectWiki, recordToWiki } from '../engine/wiki.js'

// PRD S61（v0.66，K45）— 项目 ↔ 飞书知识库页面绑定 + 机器人写页面：
// 贴链接绑定已有页面 / 指定页面下新建子页；用户「记一下」指令把内容按类型分小节追加到绑定页面。
// 连接器用 globalThis.fetch 桩（同 misc-units 模式）；权限不足翻成中文指引。

let db
let members
afterAll(() => db?.close())
const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

/** 造一个按 URL 分流的 fetch 桩：token 端点恒通，其余按 handlers 匹配。 */
function stubFetch(handlers, calls = []) {
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts })
    if (url.includes('tenant_access_token')) {
      return { ok: true, json: async () => ({ code: 0, tenant_access_token: 'tok' }) }
    }
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

describe('S61 知识库绑定与写入', () => {
  it('S61-1: 贴链接绑定已有页面——解析 node_token、get_node 验证并换出 obj_token，绑定行落库（飞书返回 snake_case）', async () => {
    ;({ db } = setupDb())
    members = seedMembers(db)
    setSetting(db, 'im.feishu', { appId: 'a', appSecret: 's' }, members.admin.id)
    const p = freshProject('智慧园区')
    const calls = stubFetch([
      // 真实飞书响应是 snake_case：node_token/obj_token/obj_type/space_id
      ['/wiki/v2/spaces/get_node', () => okJson({ node: { node_token: 'wik123', obj_token: 'doc456', obj_type: 'docx', title: '智慧园区文档', space_id: 'sp9' } })],
    ])
    const b = await bindProjectWiki(db, p.id, { wikiUrl: 'https://xxx.feishu.cn/wiki/wik123?from=copy' }, members.admin.id)
    expect(b.nodeToken).toBe('wik123')
    expect(b.objToken).toBe('doc456')
    expect(b.title).toBe('智慧园区文档')
    expect(getProjectWiki(db, p.id).objToken).toBe('doc456')
    expect(calls.some((c) => c.url.includes('/wiki/v2/spaces/get_node') && c.url.includes('token=wik123'))).toBe(true)
    expect(parseWikiNodeToken('https://x.feishu.cn/wiki/abc-DEF_123')).toBe('abc-DEF_123')
    expect(parseWikiNodeToken('https://x.feishu.cn/docx/zzz')).toBeNull()
  })

  it('S61-2: 在指定页面下新建子页并绑定——create_node 用父节点 spaceId，新页绑定落库', async () => {
    const p = freshProject('新建子页项目')
    stubFetch([
      ['/wiki/v2/spaces/get_node', () => okJson({ node: { node_token: 'parent9', obj_token: 'pdoc', obj_type: 'docx', title: '项目文档', space_id: 'sp9' } })],
      ['/wiki/v2/spaces/sp9/nodes', (url, opts) => {
        const body = JSON.parse(opts.body)
        expect(body.obj_type).toBe('docx')
        expect(body.parent_node_token).toBe('parent9')
        expect(body.title).toBe('会议纪要')
        return okJson({ node: { node_token: 'newchild1', obj_token: 'newdoc1', obj_type: 'docx', title: '会议纪要', space_id: 'sp9' } })
      }],
    ])
    const b = await bindProjectWiki(db, p.id, { parentWikiUrl: 'https://x.feishu.cn/wiki/parent9', newTitle: '会议纪要' }, members.lead.id)
    expect(b.nodeToken).toBe('newchild1')
    expect(b.objToken).toBe('newdoc1')
    expect(getProjectWiki(db, p.id).title).toBe('会议纪要')
  })

  it('S61-3: recordToWiki 按类型分小节追加——appendDocBlocks 收到 heading2(小节)+text(内容)', async () => {
    const p = freshProject('记录项目')
    // 先绑定（get_node 桩），再换桩专测追加
    stubFetch([['/wiki/v2/spaces/get_node', () => okJson({ node: { node_token: 'n1', obj_token: 'doc1', obj_type: 'docx', title: '记录项目页', space_id: 'sp1' } })]])
    await bindProjectWiki(db, p.id, { wikiUrl: 'https://x.feishu.cn/wiki/n1' }, members.admin.id)
    const calls = stubFetch([['/docx/v1/documents/doc1/blocks', () => okJson({})]])
    const r = await recordToWiki(db, p.id, { eventType: 'decision', summary: '一期范围已定' }, members.dev.id)
    expect(r.section).toBe('决策')
    const append = calls.find((c) => c.url.includes('/docx/v1/documents/doc1/blocks/doc1/children'))
    expect(append).toBeTruthy()
    const blocks = JSON.parse(append.opts.body).children
    expect(blocks[0].block_type).toBe(4) // heading2
    expect(blocks[0].heading2.elements[0].text_run.content).toBe('决策')
    expect(blocks[1].block_type).toBe(2) // text
    expect(blocks[1].text.elements[0].text_run.content).toBe('一期范围已定')
  })

  it('S61-4: 未绑定/权限不足/页面被删 → 明确中文错误', async () => {
    const p = freshProject('错误面项目')
    // 未绑定（recordToWiki 不经过 fetch，先撞未绑定闸）
    await expect(recordToWiki(db, p.id, { summary: 'x' }, members.dev.id)).rejects.toThrow('未绑定知识库')
    // 权限不足（飞书 403/131006）→ 中文指引
    stubFetch([['/wiki/v2/spaces/get_node', () => ({ ok: false, status: 403, json: async () => ({ code: 131006, msg: 'forbidden' }) })]])
    await expect(bindProjectWiki(db, p.id, { wikiUrl: 'https://x.feishu.cn/wiki/noauth' }, members.admin.id))
      .rejects.toThrow('知识库')
    // 页面不存在（get_node 返回空 node）
    stubFetch([['/wiki/v2/spaces/get_node', () => okJson({})]])
    await expect(bindProjectWiki(db, p.id, { wikiUrl: 'https://x.feishu.cn/wiki/gone' }, members.admin.id))
      .rejects.toThrow('不存在')
  })

  it('S61-5: bot 写工具——record_wiki 缺绑定回执指引、bind_wiki 权限校验与成功回执', async () => {
    const p = freshProject('机器人项目')
    const { runWriteTool } = await import('../brain/bot/tools.js')
    // record_wiki 未绑定 → refused 含指引
    const r1 = await runWriteTool(db, { kind: 'record_wiki', payload: { projectId: p.id, summary: '测试记录' } }, { member: members.dev, evt: { chatType: 'group', chatId: 'oc_x', ts: Date.now() } })
    expect(r1.type).toBe('refused')
    expect(r1.text).toContain('未绑定知识库')
    // bind_wiki 非牵头人/管理员 → refused
    const r2 = await runWriteTool(db, { kind: 'bind_wiki', payload: { projectId: p.id, wikiUrl: 'https://x.feishu.cn/wiki/n1' } }, { member: members.dev, evt: { chatType: 'group', chatId: 'oc_x' } })
    expect(r2.type).toBe('refused')
    // 管理员绑定成功 → receipt
    stubFetch([['/wiki/v2/spaces/get_node', () => okJson({ node: { node_token: 'n1', obj_token: 'doc1', obj_type: 'docx', title: '机器人项目页', space_id: 'sp1' } })]])
    const r3 = await runWriteTool(db, { kind: 'bind_wiki', payload: { projectId: p.id, wikiUrl: 'https://x.feishu.cn/wiki/n1' } }, { member: members.admin, evt: { chatType: 'group', chatId: 'oc_x' } })
    expect(r3.type).toBe('receipt')
    expect(r3.text).toContain('机器人项目页')
  })

  it('S61-6: 记到文档必须原文——LLM 浓缩时（summary 明显短于用户原文）用原文兜底，不丢信息', async () => {
    const p = freshProject('原文项目')
    stubFetch([['/wiki/v2/spaces/get_node', () => okJson({ node: { node_token: 'n1', obj_token: 'doc1', obj_type: 'docx', title: '原文项目页', space_id: 'sp1' } })]])
    await bindProjectWiki(db, p.id, { wikiUrl: 'https://x.feishu.cn/wiki/n1' }, members.admin.id)
    const { runWriteTool } = await import('../brain/bot/tools.js')
    // 用户消息原文（含触发前缀 + 多细节长文）
    const userText = '记到文档里：今天和万科确认了一期范围——含北门、东门两个出入口的车牌识别+人行摆闸，不含地下车库；二期再加南门。预算上限 48 万，下周三前出方案。'
    // LLM 浓缩成一句（丢了一期范围明细、二期、预算、时间节点）
    const summarized = '和万科确认了一期范围'
    const calls = stubFetch([['/docx/v1/documents/doc1/blocks', () => okJson({})]])
    const r = await runWriteTool(db, { kind: 'record_wiki', payload: { projectId: p.id, eventType: 'decision', summary: summarized } }, { member: members.dev, evt: { chatType: 'group', chatId: 'oc_x', ts: Date.now(), text: userText } })
    expect(r.type).toBe('receipt')
    // 追加到文档的内容必须是原文（抠掉触发前缀后的完整用户输入），不是浓缩版
    const append = calls.find((c) => c.url.includes('/docx/v1/documents/doc1/blocks/doc1/children'))
    const content = JSON.parse(append.opts.body).children[1].text.elements[0].text_run.content
    expect(content).toContain('北门、东门两个出入口')
    expect(content).toContain('二期再加南门')
    expect(content).toContain('48 万')
    expect(content).toContain('下周三')
    expect(content).not.toBe(summarized)
  })

  it('S61-6b: 用户原文本就简短时，LLM 原样传递即可（不强制替换）', async () => {
    const p = freshProject('短句项目')
    stubFetch([['/wiki/v2/spaces/get_node', () => okJson({ node: { node_token: 'n1', obj_token: 'doc1', obj_type: 'docx', title: '短句项目页', space_id: 'sp1' } })]])
    await bindProjectWiki(db, p.id, { wikiUrl: 'https://x.feishu.cn/wiki/n1' }, members.admin.id)
    const { runWriteTool } = await import('../brain/bot/tools.js')
    const userText = '记一下：一期范围已定'
    const calls = stubFetch([['/docx/v1/documents/doc1/blocks', () => okJson({})]])
    await runWriteTool(db, { kind: 'record_wiki', payload: { projectId: p.id, eventType: 'decision', summary: '一期范围已定' } }, { member: members.dev, evt: { chatType: 'group', chatId: 'oc_x', ts: Date.now(), text: userText } })
    const append = calls.find((c) => c.url.includes('/docx/v1/documents/doc1/blocks/doc1/children'))
    const content = JSON.parse(append.opts.body).children[1].text.elements[0].text_run.content
    expect(content).toBe('一期范围已定') // 原文本就简洁，不被二次加工
  })
})
