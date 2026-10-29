import { describe, it, expect, afterAll, afterEach } from 'vitest'
import { setupDb, seedMembers, setupApp, loginCookie, authed, waitFor } from './helpers.mjs'
import { createProject } from '../engine/projects.js'
import { setSetting } from '../engine/settings.js'
import { addEvent } from '../engine/events.js'
import { upsertChannel } from '../engine/tasks.js'
import { bindProjectWiki } from '../engine/wiki.js'
import { startWikiArchive, getLatestWikiArchiveRun } from '../engine/wikiArchive.js'

// PRD S63（v0.68，K48）— 项目群全量汇总归档知识库：
// 人工触发 → 全量回读绑定专题群历史（不挪游标/不进缓冲/不产事件）→ 关键时间线（确定性）
// + LLM 分块产重要内容/金句 + 群内图片搬运 → 写入绑定页面最后一个「项目汇总」章节（幂等替换）。
// 连接器用 globalThis.fetch 桩（同 s61 模式）；docx GET/POST 同路径按 method 分流。

let db
let members
afterAll(() => db?.close())
const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

const okJson = (data) => ({ ok: true, json: async () => ({ code: 0, data }) })
const el = (t) => ({ elements: [{ text_run: { content: t } }] })

/** 造一条飞书消息原始 item（list API 返回形态）。file 附件消息传 fileKey/fileName。 */
function msg(id, sec, senderId, text, { senderType = 'user', msgType = 'text', imageKey, fileKey, fileName } = {}) {
  const content = msgType === 'image' ? { image_key: imageKey } : msgType === 'file' ? { file_key: fileKey, file_name: fileName } : { text }
  return {
    message_id: id, create_time: String(sec), msg_type: msgType,
    sender: { id: senderId, sender_type: senderType },
    body: { content: JSON.stringify(content) },
  }
}

/** 绑定/台账阶段共用：token 端点恒通，其余按 handlers 匹配（s61 同款）。url 统一转字符串（连接器会传 URL 对象）。 */
function stubFetch(handlers, calls = []) {
  globalThis.fetch = async (rawUrl, opts) => {
    const url = String(rawUrl)
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

/**
 * 归档阶段 fetch 桩：消息分页 pages、文档现有根块 blocks、图片下载 imageResponder。
 * 返回 calls 供断言（消息翻页、插入 index、batch_delete 区间）。
 */
function stubArchiveFetch({ pages = [{ items: [], has_more: false }], blocks = [], insertResult, imageResponder, fileResponder, extra = [], onUpload } = {}) {
  const calls = []
  let pageIdx = 0
  let uploadSeq = 0
  globalThis.fetch = async (rawUrl, opts = {}) => {
    const url = String(rawUrl)
    calls.push({ url, opts })
    if (url.includes('tenant_access_token')) return { ok: true, json: async () => ({ code: 0, tenant_access_token: 'tok' }) }
    if (url.includes('/im/v1/images/')) {
      if (imageResponder) return imageResponder(url)
      return { ok: false, status: 404, json: async () => ({ code: 404, msg: 'not found' }) }
    }
    if (url.includes('/im/v1/messages/') && url.includes('/resources/')) {
      if (fileResponder) return fileResponder(url)
      return { ok: false, status: 404, json: async () => ({ code: 404, msg: 'not found' }) }
    }
    if (url.includes('/im/v1/messages')) {
      const page = pages[Math.min(pageIdx++, pages.length - 1)]
      return okJson(page)
    }
    if (url.includes('/drive/v1/medias/upload_all')) {
      if (onUpload) onUpload(opts)
      return okJson({ file_token: `ft_${++uploadSeq}` })
    }
    if (url.includes('/children/batch_delete')) return okJson({})
    if (url.includes('/docx/v1/documents/') && url.includes('/children')) {
      if ((opts.method ?? 'GET') === 'GET') return okJson({ items: blocks, has_more: false })
      return okJson(insertResult ?? { children: [{ block_id: 'gen1' }] })
    }
    for (const [match, responder] of extra) {
      if (url.includes(match)) return responder(url, opts)
    }
    return okJson({})
  }
  return calls
}

/** 新项目 + 飞书凭证 + 绑定专题群（oc_arch）。 */
function fresh(name = '归档项目') {
  ;({ db } = setupDb())
  members = seedMembers(db)
  setSetting(db, 'im.feishu', { appId: 'a', appSecret: 's' }, members.admin.id)
  const project = createProject(db, { name, typeCode: 'lianmai_365', leadMemberId: members.lead.id }, members.admin.id)
  upsertChannel(db, { platform: 'feishu', groupKey: 'oc_arch', name: `${name}群`, channelType: 'dedicated', projectId: project.id }, members.admin.id)
  return project
}

async function bindWiki(project) {
  stubFetch([['/wiki/v2/spaces/get_node', () => okJson({ node: { node_token: 'n1', obj_token: 'doc1', obj_type: 'docx', title: `${project.name}页`, space_id: 'sp1' } })]])
  await bindProjectWiki(db, project.id, { wikiUrl: 'https://x.feishu.cn/wiki/n1' }, members.admin.id)
}

const createdSecOf = (pid) => Math.floor(Number(db.prepare('SELECT created_at FROM projects WHERE id = ?').get(pid).created_at) / 1000)

/** 从 calls 里取 docx 内容插入（POST children，排除 batch_delete）的请求体。 */
function insertedChildren(calls) {
  const c = calls.find((x) => x.url.includes('/children') && !x.url.includes('batch_delete') && x.opts.method === 'POST')
  return c ? JSON.parse(c.opts.body) : null
}

describe('S63 项目群全量汇总归档知识库', () => {
  it('S63-1: 触发校验——未绑定知识库 400 / 未绑定专题群 400 / 运行中重复触发 409 / 非牵头人管理员 403', async () => {
    const p = fresh()
    // 未绑定知识库页面 → 400 指引
    const e1 = await startWikiArchive(db, p.id, members.admin.id).catch((e) => e)
    expect(e1.statusCode).toBe(400)
    expect(e1.message).toContain('知识库')
    // 绑定知识库但无专题群的项目 → 400
    const p2 = createProject(db, { name: '无群项目', typeCode: 'lianmai_365', leadMemberId: members.lead.id }, members.admin.id)
    await bindWiki(p2)
    const e2 = await startWikiArchive(db, p2.id, members.admin.id).catch((e) => e)
    expect(e2.statusCode).toBe(400)
    expect(e2.message).toContain('专题群')
    // 已有运行中汇总 → 409
    await bindWiki(p)
    db.prepare("INSERT INTO wiki_archive_runs (project_id, status, stage, created_at) VALUES (?, 'running', 'fetch', ?)").run(p.id, Date.now())
    const e3 = await startWikiArchive(db, p.id, members.admin.id).catch((e) => e)
    expect(e3.statusCode).toBe(409)
    // 非牵头人/管理员 → 路由 403（dev 李四既不是 admin 也不是牵头人）
    const { app, db: db2, members: m2 } = await setupApp()
    const p3 = createProject(db2, { name: '越权项目', typeCode: 'lianmai_365', leadMemberId: m2.lead.id }, m2.admin.id)
    const cookie = await loginCookie(app, 'lisi', 'pass-123456')
    const res = await authed(app, cookie, 'POST', `/api/v1/projects/${p3.id}/wiki-archive`)
    expect(res.status).toBe(403)
    await app.close()
  })

  it('S63-2: 全量回读——从项目创建时刻降序分页拉完，过滤机器人/空文本；不挪游标、不进缓冲、不产事件', async () => {
    const p = fresh()
    await bindWiki(p)
    const createdSec = createdSecOf(p.id)
    const cursorBefore = db.prepare('SELECT cursor FROM channels WHERE project_id = ?').get(p.id).cursor
    const eventsBefore = db.prepare('SELECT COUNT(*) AS n FROM project_events WHERE project_id = ?').get(p.id).n
    const calls = stubArchiveFetch({
      pages: [
        {
          items: [
            msg('m4', createdSec + 9000, 'fs_li', '', { msgType: 'image', imageKey: 'img_k1' }), // 图片进图片列
            msg('m3', createdSec + 8600, 'fs_li', '  '), // 空文本过滤
            msg('m2', createdSec + 7200, 'fs_bot', '机器人播报', { senderType: 'app' }), // 机器人自身过滤
          ],
          has_more: true, page_token: 'p2',
        },
        { items: [msg('m1', createdSec + 3600, 'fs_zhang', '项目今天正式启动，一期含北门东门')], has_more: false },
      ],
    })
    const run = await startWikiArchive(db, p.id, members.admin.id, { defer: false })
    expect(run.status).toBe('done')
    const msgCalls = calls.filter((c) => c.url.includes('/im/v1/messages'))
    expect(msgCalls.length).toBe(2) // 分页拉完
    expect(msgCalls[0].url).toContain(`start_time=${createdSec}`) // 自项目创建时刻起
    expect(msgCalls[0].url).toContain('ByCreateTimeDesc')
    expect(msgCalls[1].url).toContain('page_token=p2')
    expect(run.messageCount).toBe(1) // 仅 m1 是有效文本
    // 三不：不挪游标 / 不进 im_buffer / 不产 project_events
    expect(db.prepare('SELECT cursor FROM channels WHERE project_id = ?').get(p.id).cursor).toBe(cursorBefore)
    expect(db.prepare('SELECT COUNT(*) AS n FROM im_buffer').get().n).toBe(0)
    expect(db.prepare('SELECT COUNT(*) AS n FROM project_events WHERE project_id = ?').get(p.id).n).toBe(eventsBefore) // 归档不新增事件
  })

  it('S63-3: 关键时间线确定性生成——事件流+里程碑+任务完成按日聚合；LLM 缺席照样完整', async () => {
    const p = fresh()
    await bindWiki(p)
    addEvent(db, { projectId: p.id, eventType: 'decision', summary: '一期范围敲定（北门+东门）', businessTime: Date.UTC(2026, 5, 3, 3), generatedBy: 'extraction' })
    addEvent(db, { projectId: p.id, eventType: 'risk', summary: '摆闸供货可能延期', businessTime: Date.UTC(2026, 5, 5, 2) })
    addEvent(db, { projectId: p.id, nature: 'suggestion', eventType: 'suggestion', summary: '建议调整排期', businessTime: Date.UTC(2026, 5, 6, 2) }) // pending 建议不进时间线
    db.prepare("INSERT INTO milestones (project_id, name, plan_date, status, created_at, updated_at) VALUES (?, '一期交付', '2026-07-01', 'met', ?, ?)").run(p.id, Date.now(), Date.now())
    db.prepare("INSERT INTO tasks (project_id, title, status, created_at, updated_at) VALUES (?, '北门车牌识别联调', 'done', ?, ?)").run(p.id, Date.now(), Date.UTC(2026, 5, 10, 8)) // 北京 2026-06-10
    const calls = stubArchiveFetch({})
    const run = await startWikiArchive(db, p.id, members.admin.id, { defer: false }) // 无 LLM 配置 → 确定性降级
    expect(run.status).toBe('done')
    const body = insertedChildren(calls)
    const text = JSON.stringify(body.children)
    expect(text).toContain('2026-06-03')
    expect(text).toContain('一期范围敲定')
    expect(text).toContain('摆闸供货可能延期')
    expect(text).toContain('2026-07-01')
    expect(text).toContain('一期交付')
    expect(text).toContain('2026-06-10')
    expect(text).toContain('北门车牌识别联调')
    expect(text).not.toContain('建议调整排期')
    expect(text).toContain('未配置 LLM') // 金句区如实标注降级
  })

  it('S63-4: LLM 分块汇总——按约 12000 字分块提取再定稿，重要内容 ≤8 条、金句 ≤10 条带说话人', async () => {
    const p = fresh()
    await bindWiki(p)
    const createdSec = createdSecOf(p.id)
    const longText = '北门车牌识别验收细节确认：识别率要求 99.5%，雨雪模式单独测试，周末加班联调。'.repeat(8)
    const items = Array.from({ length: 80 }, (_, i) => msg(`m${i}`, createdSec + i * 60, i % 2 ? 'fs_zhang' : 'fs_li', `${longText}#${i}`))
    const calls = stubArchiveFetch({ pages: [{ items, has_more: false }] })
    let chunkCalls = 0
    let mergeCalls = 0
    const llm = {
      name: 'fake',
      complete: async (messages) => {
        const sys = messages[0].content
        if (sys.includes('定稿')) {
          mergeCalls++
          return JSON.stringify({
            highlights: Array.from({ length: 12 }, (_, i) => `重要内容${i + 1}`), // 超帽 → 引擎截断到 8
            quotes: Array.from({ length: 15 }, (_, i) => ({ speaker: '张三', text: `金句${i + 1}` })), // 超帽 → 截断到 10
          })
        }
        chunkCalls++
        return JSON.stringify({ notes: [`片段要点${chunkCalls}`], quotes: [{ speaker: '李四', text: `片段金句${chunkCalls}` }] })
      },
    }
    const run = await startWikiArchive(db, p.id, members.admin.id, { defer: false, llm })
    expect(run.status).toBe('done')
    expect(chunkCalls).toBeGreaterThanOrEqual(2) // 超 12000 字 → 至少 2 块
    expect(run.chunkCount).toBe(chunkCalls)
    expect(mergeCalls).toBe(1)
    expect(run.quotesCount).toBe(10) // 截断到帽
    const body = insertedChildren(calls)
    const children = body.children
    const textOf = (b) => (b.bullet || b.text || b.heading3)?.elements?.[0]?.text_run?.content || ''
    // 重要内容小节：heading3「重要内容」之后到下一标题之间的 bullet 数 ≤8
    const hiIdx = children.findIndex((b) => b.block_type === 5 && b.heading3.elements[0].text_run.content === '重要内容')
    let hiCount = 0
    for (let i = hiIdx + 1; i < children.length && children[i].block_type === 12; i++) hiCount++
    expect(hiCount).toBe(8)
    expect(children.some((b) => textOf(b).includes('重要内容1'))).toBe(true)
    expect(children.some((b) => textOf(b).includes('金句1') && textOf(b).includes('张三'))).toBe(true)
  })

  it('S63-5: 章节定位——写入最后一个「项目汇总」章节末尾；无章节则文末新建 heading2', async () => {
    const p = fresh()
    await bindWiki(p)
    const blocks = [
      { block_id: 'b1', block_type: 3, heading1: el('项目背景') },
      { block_id: 'b2', block_type: 2, text: el('背景介绍……') },
      { block_id: 'b3', block_type: 4, heading2: el('项目汇总') },
      { block_id: 'b4', block_type: 2, text: el('人工写的旧内容') },
      { block_id: 'b5', block_type: 4, heading2: el('附录') },
    ]
    const calls = stubArchiveFetch({ blocks })
    await startWikiArchive(db, p.id, members.admin.id, { defer: false })
    const body = insertedChildren(calls)
    expect(body.index).toBe(4) // 「附录」之前 = 项目汇总章节末
    expect(body.children[0].block_type).toBe(2) // 首标记行（章节已存在，不再新建标题）
    expect(body.children[0].text.elements[0].text_run.content).toContain('项目大脑汇总')
    // 生成区结构：首标记 → 关键时间线 → 重要内容 → 群内金句 → 群内图片 → 群内附件 → 尾标记
    const headings = body.children.filter((b) => b.block_type === 5).map((b) => b.heading3.elements[0].text_run.content)
    expect(headings).toEqual(['关键时间线', '重要内容', '群内金句', '群内图片', '群内附件'])
    expect(body.children.at(-1).text.elements[0].text_run.content).toContain('汇总结束')

    // 无「项目汇总」章节 → 文末新建 heading2，追加（不传 index）
    const p2 = createProject(db, { name: '新章节项目', typeCode: 'lianmai_365', leadMemberId: members.lead.id }, members.admin.id)
    upsertChannel(db, { platform: 'feishu', groupKey: 'oc_arch2', name: '新章节项目群', channelType: 'dedicated', projectId: p2.id }, members.admin.id)
    await bindWiki(p2)
    const calls2 = stubArchiveFetch({ blocks: [{ block_id: 'b1', block_type: 3, heading1: el('项目背景') }] })
    await startWikiArchive(db, p2.id, members.admin.id, { defer: false })
    const body2 = insertedChildren(calls2)
    expect(body2.index).toBeUndefined()
    expect(body2.children[0].block_type).toBe(4) // heading2
    expect(body2.children[0].heading2.elements[0].text_run.content).toBe('项目汇总')
    expect(body2.children[1].text.elements[0].text_run.content).toContain('项目大脑汇总')
  })

  it('S63-6: 幂等重跑——按锚点删旧生成区（首标记到尾标记含）再原位写入，页面只留最新一版', async () => {
    const p = fresh()
    await bindWiki(p)
    // 第一次：空页面（无章节）→ 文末新建；插入返回首块 gen1 落锚点
    stubArchiveFetch({ blocks: [], insertResult: { children: [{ block_id: 'gen1' }] } })
    const run1 = await startWikiArchive(db, p.id, members.admin.id, { defer: false })
    expect(run1.status).toBe('done')
    expect(run1.firstBlockId).toBe('gen1')
    // 第二次：页面已有旧生成区（首尾标记）+ 后续章节
    const blocks2 = [
      { block_id: 'b0', block_type: 4, heading2: el('项目汇总') },
      { block_id: 'gen1', block_type: 2, text: el('🤖 项目大脑汇总 · 生成于 2026-10-10 09:00 · 回读群消息 5 条') },
      { block_id: 'g2', block_type: 12, bullet: el('[2026-06-01] 进展：旧条目') },
      { block_id: 'g3', block_type: 2, text: el('— 项目大脑汇总结束 —') },
      { block_id: 'b9', block_type: 4, heading2: el('附录') },
    ]
    const calls2 = stubArchiveFetch({ blocks: blocks2 })
    const run2 = await startWikiArchive(db, p.id, members.admin.id, { defer: false })
    expect(run2.status).toBe('done')
    const del = calls2.find((c) => c.url.includes('batch_delete'))
    expect(del).toBeTruthy()
    expect(JSON.parse(del.opts.body)).toMatchObject({ start_index: 1, end_index: 4 }) // 首标记到尾标记（含）
    const body2 = insertedChildren(calls2)
    expect(body2.index).toBe(1) // 原位写入新版
    expect(body2.children[0].text.elements[0].text_run.content).toContain('项目大脑汇总')
  })

  it('S63-7: 运行台账——POST 立即返回 running；轮询到 done 带统计与页面链接；失败带中文错误', async () => {
    const { app, db: db2, members: m2 } = await setupApp()
    setSetting(db2, 'im.feishu', { appId: 'a', appSecret: 's' }, m2.admin.id)
    const p = createProject(db2, { name: '台账项目', typeCode: 'lianmai_365', leadMemberId: m2.lead.id }, m2.admin.id)
    upsertChannel(db2, { platform: 'feishu', groupKey: 'oc_ledger', name: '台账项目群', channelType: 'dedicated', projectId: p.id }, m2.admin.id)
    stubFetch([['/wiki/v2/spaces/get_node', () => okJson({ node: { node_token: 'n9', obj_token: 'doc9', obj_type: 'docx', title: '台账项目页', space_id: 'sp1' } })]])
    await bindProjectWiki(db2, p.id, { wikiUrl: 'https://x.feishu.cn/wiki/n9' }, m2.admin.id)
    const createdSec = Math.floor(Number(db2.prepare('SELECT created_at FROM projects WHERE id = ?').get(p.id).created_at) / 1000)
    stubArchiveFetch({ pages: [{ items: [msg('m1', createdSec + 60, 'fs_zhang', '项目正式启动了')], has_more: false }] })
    const cookie = await loginCookie(app, 'admin', 'admin-pass-123')
    const post = await authed(app, cookie, 'POST', `/api/v1/projects/${p.id}/wiki-archive`)
    expect(post.status).toBe(202)
    expect(post.body.run.status).toBe('running')
    await waitFor(async () => {
      const g = await authed(app, cookie, 'GET', `/api/v1/projects/${p.id}/wiki-archive`)
      return g.body.run?.status === 'done'
    })
    const g = await authed(app, cookie, 'GET', `/api/v1/projects/${p.id}/wiki-archive`)
    expect(g.body.run.messageCount).toBe(1)
    expect(g.body.run.pageUrl).toContain('/wiki/n9')
    expect(g.body.run.error ?? null).toBeNull()
    // 失败路径：消息接口报错 → failed + 中文错误
    stubFetch([['/im/v1/messages', () => ({ ok: false, status: 502, json: async () => ({ code: 500, msg: 'boom' }) })]])
    const post2 = await authed(app, cookie, 'POST', `/api/v1/projects/${p.id}/wiki-archive`)
    expect(post2.status).toBe(202)
    await waitFor(async () => {
      const g2 = await authed(app, cookie, 'GET', `/api/v1/projects/${p.id}/wiki-archive`)
      return g2.body.run?.status === 'failed'
    })
    const g2 = await authed(app, cookie, 'GET', `/api/v1/projects/${p.id}/wiki-archive`)
    expect(g2.body.run.error).toContain('飞书')
    await app.close()
  })

  it('S63-8: 群内图片归档——下载 image_key → 上传素材 → image block，单张失败跳过不阻塞，计数如实', async () => {
    const p = fresh()
    await bindWiki(p)
    const createdSec = createdSecOf(p.id)
    const items = [
      msg('m1', createdSec + 100, 'fs_zhang', '看这张现场图'),
      msg('m2', createdSec + 200, 'fs_li', '', { msgType: 'image', imageKey: 'img_ok1' }),
      msg('m3', createdSec + 300, 'fs_zhang', '', { msgType: 'image', imageKey: 'img_ok2' }),
      msg('m4', createdSec + 400, 'fs_li', '', { msgType: 'image', imageKey: 'img_bad' }), // 下载 404 → 跳过
    ]
    const imageResponder = (url) => {
      if (url.includes('img_bad')) return { ok: false, status: 404, json: async () => ({ code: 404, msg: 'not found' }) }
      return { ok: true, status: 200, headers: { get: () => 'image/jpeg' }, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }
    }
    const calls = stubArchiveFetch({ pages: [{ items, has_more: false }], imageResponder })
    const run = await startWikiArchive(db, p.id, members.admin.id, { defer: false })
    expect(run.status).toBe('done')
    expect(run.imageCount).toBe(2) // 两张成功，坏图跳过
    const body = insertedChildren(calls)
    const images = body.children.filter((b) => b.block_type === 27)
    expect(images.length).toBe(2)
    expect(images.map((b) => b.image.token)).toEqual(['ft_1', 'ft_2']) // 按时间序上传
    const captions = body.children.filter((b) => b.block_type === 2).map((b) => b.text.elements[0].text_run.content)
    expect(captions.some((t) => t.includes('李四'))).toBe(true) // 图注带说话人
    expect(captions.some((t) => t.includes('张三'))).toBe(true)
  })

  it('S65-1: file 附件消息解析出 file_key/file_name，且不再混入汇总文本行', async () => {
    const p = fresh()
    await bindWiki(p)
    const createdSec = createdSecOf(p.id)
    const calls = stubArchiveFetch({
      pages: [
        {
          items: [
            msg('f1', createdSec + 100, 'fs_zhang', '', { msgType: 'file', fileKey: 'fk_1', fileName: '验收清单.xlsx' }),
          ],
          has_more: true, page_token: 'p2',
        },
        { items: [msg('t1', createdSec + 200, 'fs_li', '方案已确认')], has_more: false },
      ],
      fileResponder: (_url) => ({ ok: true, status: 200, headers: { get: () => 'application/octet-stream' }, body: (async function* () { yield Uint8Array.from([1, 2, 3]) })() }),
    })
    const run = await startWikiArchive(db, p.id, members.admin.id, { defer: false })
    expect(run.status).toBe('done')
    expect(run.fileCount).toBe(1)
    const body = insertedChildren(calls)
    const text = JSON.stringify(body.children)
    expect(text).toContain('验收清单.xlsx')
    expect(text).not.toContain('file_key') // 附件消息不进汇总文本行
    // 无 LLM 时「方案已确认」进有效文本行供 LLM 分块（本测试未配 LLM，故只断言未混入 file 消息内容）
    expect(text).not.toContain('fk_1')
  })

  it('S65-2: <20MB 附件经消息资源下载→docx_file 上传→file block，命名/图注/上限计数如实', async () => {
    const p = fresh()
    await bindWiki(p)
    const createdSec = createdSecOf(p.id)
    const uploadParentTypes = []
    const items = [
      msg('t1', createdSec + 100, 'fs_zhang', '文件发你'),
      msg('f1', createdSec + 200, 'fs_li', '', { msgType: 'file', fileKey: 'fk_a', fileName: '报价单.pdf' }),
      msg('f2', createdSec + 300, 'fs_zhang', '', { msgType: 'file', fileKey: 'fk_b', fileName: 'fk_b' }), // 缺 file_name 时消息侧已兜底为 file_key
    ]
    const calls = stubArchiveFetch({
      pages: [{ items, has_more: false }],
      fileResponder: (_url) => ({ ok: true, status: 200, headers: { get: () => 'application/pdf' }, body: (async function* () { yield Uint8Array.from([9, 9]) })() }),
      onUpload: (opts) => { const fd = opts.body; if (fd?.get) uploadParentTypes.push(fd.get('parent_type')) },
    })
    const run = await startWikiArchive(db, p.id, members.admin.id, { defer: false })
    expect(run.status).toBe('done')
    expect(run.fileCount).toBe(2)
    const resCalls = calls.filter((c) => c.url.includes('/resources/'))
    expect(resCalls.length).toBe(2)
    const resUrls = resCalls.map((c) => c.url).sort()
    expect(resUrls[0]).toContain(`messages/f1/resources/fk_a?type=file`)
    expect(resUrls[1]).toContain(`messages/f2/resources/fk_b?type=file`)
    const uploads = calls.filter((c) => c.url.includes('/drive/v1/medias/upload_all'))
    expect(uploads.length).toBe(2)
    expect(uploadParentTypes).toEqual(['docx_file', 'docx_file'])
    const body = insertedChildren(calls)
    const files = body.children.filter((b) => b.block_type === 23)
    expect(files.length).toBe(2)
    // v0.80.1 工程防线：file 块载荷按官方 schema 仅含 token（多带 name 有 99992402 严格校验风险）；
    // v0.85：块类型 23=file（18=bitable，gb-test run#2 实证 1770001）——文件名在图注里
    expect(files[0].file).toEqual({ token: 'ft_1' })
    expect(files[1].file).toEqual({ token: 'ft_2' })
    const captions = body.children.filter((b) => b.block_type === 2).map((b) => b.text.elements[0].text_run.content)
    expect(captions.some((t) => t.includes('李四') && t.includes('报价单.pdf'))).toBe(true)
    // 附件消息原文不混入汇总文本行；有效文本（t1）在无 LLM 时进 lines 供分块——这里只断言写入的生成区不含 file_key
    expect(JSON.stringify(body.children)).not.toContain('file_key')
  })

  it('S65-3: 失败附件跳过不阻塞主流程，页面列明原因且 skipped_files 台账如实', async () => {
    const p = fresh()
    await bindWiki(p)
    const createdSec = createdSecOf(p.id)
    const items = [
      msg('f_bad', createdSec + 100, 'fs_li', '', { msgType: 'file', fileKey: 'fk_bad', fileName: '坏文件.zip' }),
      msg('f_ok', createdSec + 200, 'fs_zhang', '', { msgType: 'file', fileKey: 'fk_ok', fileName: '纪要.docx' }),
      msg('t1', createdSec + 300, 'fs_li', '现场施工完成'),
    ]
    const fileResponder = (url) => {
      if (url.includes('fk_bad')) return { ok: false, status: 404, json: async () => ({ code: 404, msg: 'not found' }) }
      return { ok: true, status: 200, headers: { get: () => 'application/octet-stream' }, body: (async function* () { yield Uint8Array.from([7]) })() }
    }
    const calls = stubArchiveFetch({ pages: [{ items, has_more: false }], fileResponder })
    const run = await startWikiArchive(db, p.id, members.admin.id, { defer: false })
    expect(run.status).toBe('done')
    expect(run.fileCount).toBe(1)
    const skipped = JSON.parse(run.skippedFiles || '[]')
    expect(skipped).toEqual([{ name: '坏文件.zip', reason: expect.stringContaining('404') }])
    const body = insertedChildren(calls)
    const text = JSON.stringify(body.children)
    expect(text).toContain('坏文件.zip')
    // 无 LLM 时「现场施工完成」进有效文本行供分块（本测试未配 LLM，故只断言主流程未因坏附件中断：done + 成功附件已写入）
    expect(run.status).toBe('done')
    expect(text).toContain('纪要.docx')
  })

  it('S63-7 补充：getLatestWikiArchiveRun 直读台账——运行中/完成/失败状态如实', async () => {
    const p = fresh()
    await bindWiki(p)
    expect(getLatestWikiArchiveRun(db, p.id)).toBeNull()
    stubArchiveFetch({})
    const run = await startWikiArchive(db, p.id, members.admin.id, { defer: false })
    const latest = getLatestWikiArchiveRun(db, p.id)
    expect(latest.id).toBe(run.id)
    expect(latest.status).toBe('done')
    expect(latest.createdBy).toBe(members.admin.id)
  })
})

// —— 【工程防线】S63 写入修复（v0.80.1 + v0.85）：gb-test 线上实证——
// v0.80.1：飞书 docx 批量建块接口单次 children ≤50 硬上限（超限整包被拒 99992402，~80 块一次 POST）；
//   file 块创建载荷按官方 schema 仅含 token（名称由图注文本块承担）。
// v0.85：file 块 block_type=23（官方枚举 18=bitable 多维表格）——run#2 实证：首批 50 块（纯文本/标题/列表）
//   写入成功，含 file 块的第二批整包被 1770001 invalid param 拒掉，页面残留半截时间线。 ——

/** 收集全部 docx 内容插入 POST（排除 batch_delete）的请求体。 */
function allInsertBodies(calls) {
  return calls
    .filter((x) => x.url.includes('/docx/v1/documents/') && x.url.includes('/children') && !x.url.includes('batch_delete') && x.opts.method === 'POST')
    .map((x) => JSON.parse(x.opts.body))
}

describe('【工程防线】S63 写块分批与 file 块 schema（99992402/1770001 修复）', () => {
  it('分批写入：块数超 50 自动拆多次 POST，单次 ≤50、块数不丢、幂等锚点=首批首块', async () => {
    const p = fresh()
    await bindWiki(p)
    // 时间线做大：模板任务置 done + 50 条记录事件 → 64 条 → 截 60 + 省略说明 = 61 块，加结构块约 71 块
    db.prepare("UPDATE tasks SET status = 'done' WHERE project_id = ?").run(p.id)
    for (let i = 0; i < 50; i++) {
      addEvent(db, { projectId: p.id, eventType: 'progress', nature: 'record', summary: `进展事项 ${i}`, speakerMemberId: members.admin.id })
    }
    const calls = stubArchiveFetch({ pages: [{ items: [], has_more: false }] })
    const run = await startWikiArchive(db, p.id, members.admin.id, { defer: false })
    expect(run.status).toBe('done')
    const bodies = allInsertBodies(calls)
    expect(bodies.length).toBeGreaterThanOrEqual(2) // 修复前整包一次 POST（线上被飞书 99992402 拒）
    for (const b of bodies) expect(b.children.length).toBeLessThanOrEqual(50)
    expect(bodies.reduce((s, b) => s + b.children.length, 0)).toBeGreaterThan(50) // 块数完整送达
    expect(run.firstBlockId).toBe('gen1') // 幂等锚点=首批首块（分批后仍取首批返回）
  })

  it('file 块载荷仅含 token（官方 schema）：block_type=23（18=bitable），name 不进块结构，文件名由图注承担', async () => {
    const p = fresh()
    await bindWiki(p)
    const createdSec = createdSecOf(p.id)
    const calls = stubArchiveFetch({
      pages: [{ items: [msg('mf', createdSec + 3600, 'fs_li', '', { msgType: 'file', fileKey: 'fk1', fileName: '验收报告.pdf' })], has_more: false }],
      fileResponder: (_url) => ({ ok: true, status: 200, headers: { get: () => 'application/pdf' }, body: (async function* () { yield Uint8Array.from([1, 2, 3]) })() }),
    })
    const run = await startWikiArchive(db, p.id, members.admin.id, { defer: false })
    expect(run.status).toBe('done')
    expect(run.fileCount).toBe(1)
    const blocks = allInsertBodies(calls).flatMap((b) => b.children)
    const fileBlocks = blocks.filter((b) => b.block_type === 23)
    expect(fileBlocks.length).toBe(1)
    expect(blocks.some((b) => b.block_type === 18)).toBe(false) // 18=bitable（gb-test 1770001 实证）
    expect(Object.keys(fileBlocks[0].file)).toEqual(['token']) // 多字段会被严格校验拒（99992402 风险面）
    expect(fileBlocks[0].file.token).toBe('ft_1')
    const texts = blocks.filter((b) => b.block_type === 2).map((b) => b.text.elements[0].text_run.content)
    expect(texts.some((t) => t.includes('验收报告.pdf'))).toBe(true) // 文件名在图注里可见
  })

  it('insertDocBlocks 指定 index 时随批递增：120 块 → 3 次 POST（50/50/20），index = 7/57/107', async () => {
    const { insertDocBlocks } = await import('../brain/connectors/feishu.js')
    let postSeq = 0 // 独立计数器（calls 含 token 调用，勿用 calls.length 生成 id）
    const calls = stubFetch([['/children', (_url, opts) => {
      const n = JSON.parse(opts.body).children.length
      const seq = ++postSeq
      return okJson({ children: Array.from({ length: n }, (_, i) => ({ block_id: `b_${seq}_${i}` })) })
    }]])
    const blocks = Array.from({ length: 120 }, (_, i) => ({ block_type: 2, text: { elements: [{ text_run: { content: `行${i}` } }] } }))
    const created = await insertDocBlocks({ appId: 'a', appSecret: 's' }, 'doc1', blocks, 7)
    const posts = calls.filter((c) => String(c.url).includes('/children') && c.opts.method === 'POST')
    expect(posts.map((c) => JSON.parse(c.opts.body).children.length)).toEqual([50, 50, 20])
    expect(posts.map((c) => JSON.parse(c.opts.body).index)).toEqual([7, 57, 107])
    expect(created).toHaveLength(120)
    expect(created[0].block_id).toBe('b_1_0') // 首块来自首批（幂等锚点语义不变）
  })
})
