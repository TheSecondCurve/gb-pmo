import { describe, it, expect, afterAll, afterEach } from 'vitest'
import { setupApp, loginCookie, authed, waitFor } from './helpers.mjs'
import { createProject, cancelProject } from '../engine/projects.js'
import { setSetting } from '../engine/settings.js'
import { upsertChannel } from '../engine/tasks.js'
import { chatCloseMarkNotice } from '../engine/channels.js'
import { createProposal, confirmProposal } from '../engine/proposals.js'
import { handleBotEvent } from '../brain/bot/command.js'
import { scriptedLlm, makeRecorder, makeMsgFactory, flattenPost, BOT_SECRET } from './bot-kit.mjs'

// PRD S76（v0.89，design.md K76）— 结项自动标记专题群群名【已结项】：
// 三入口（web 结项 / 提议确认卡 / 机器人一条链）结项成功后对项目绑定的每个飞书专题群
// （dedicated，可多群）GET 当前群名 → PUT 追加【已结项】→ 同步 channels.name + audit；
// 尽力而为不阻断、幂等可重入；通用群不标记、取消不标记；与 K73 知识页标记互不影响。

let ctx
afterAll(() => ctx?.db.close())
const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

const okJson = (data) => ({ ok: true, json: async () => ({ code: 0, data }) })
const sentText = (m) => m.text ?? (m.post ? flattenPost(m.post) : '')

/** 建库 + 配飞书凭证；返回 { ctx, cookie }。 */
async function boot() {
  ctx = await setupApp()
  setSetting(ctx.db, 'im.feishu', { appId: 'a', appSecret: 's' }, ctx.members.admin.id)
  const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
  return { ctx, cookie }
}

/** 建项目（任务全完成）+ 可选绑群。 */
async function primeProject(db, name, { groupKey, channelType = 'dedicated', snapshotName } = {}) {
  const p = createProject(db, { name, typeCode: 'lianmai_365', leadMemberId: ctx.members.lead.id }, ctx.members.admin.id)
  db.prepare('UPDATE tasks SET status = ? WHERE project_id = ?').run('done', p.id)
  if (groupKey) upsertChannel(db, { platform: 'feishu', groupKey, name: snapshotName, channelType, projectId: p.id }, ctx.members.admin.id)
  return p
}

/** 桩：token 恒通；GET 群信息回 currentName（群当前名≠绑定快照）；PUT 改名捕获（putResult 驱动失败）。 */
function stubChatRename({ currentName, putResult } = {}) {
  const puts = []
  const urls = []
  globalThis.fetch = async (rawUrl, opts = {}) => {
    const url = String(rawUrl)
    urls.push(url)
    if (url.includes('tenant_access_token')) return { ok: true, json: async () => ({ code: 0, tenant_access_token: 'tok' }) }
    if (url.includes('/wiki/v2/spaces/get_node')) return okJson({ node: { node_token: 'n76', obj_token: 'doc76', obj_type: 'docx', title: `${currentName}页`, space_id: 'sp1' } })
    if (url.includes('/wiki/v2/spaces/sp1/nodes/n76/update_title')) return okJson({})
    if (url.includes('/im/v1/chats/') && (opts.method ?? 'GET') === 'GET') return okJson({ name: currentName })
    if (url.includes('/im/v1/chats/') && opts.method === 'PUT') {
      puts.push({ method: 'PUT', body: JSON.parse(opts.body) })
      return putResult ?? okJson({})
    }
    return okJson({})
  }
  return { puts, urls }
}

const channelRow = (groupKey) => ctx.db.prepare('SELECT name FROM channels WHERE group_key = ?').get(groupKey)

describe('S76 结项自动标记专题群群名', () => {
  it('S76-1: web 结项——群名追加【已结项】（基于群当前名而非 channels 快照，多群逐个），channels.name 同步 + audit，响应带 chatCloseMark', async () => {
    const { cookie } = await boot()
    const p = await primeProject(ctx.db, 'S76甲项目', { groupKey: 'oc_s76a', snapshotName: '旧快照名' })
    upsertChannel(ctx.db, { platform: 'feishu', groupKey: 'oc_s76b', channelType: 'dedicated', projectId: p.id }, ctx.members.admin.id)
    const { puts } = stubChatRename({ currentName: '线上群名A' }) // 两个群 GET 同名（按 groupKey 逐一改名）
    const res = await authed(ctx.app, cookie, 'POST', `/api/v1/projects/${p.id}/close`, { summary: '验收通过' })
    expect(res.status).toBe(200)
    expect(res.body.chatCloseMark).toContain('专题群名已标记')
    expect(res.body.chatCloseMark).toContain('线上群名A【已结项】')
    expect(puts).toHaveLength(2) // 多群逐个：两条 PUT，载荷均为 当前名+标记（非快照「旧快照名」）
    expect(puts.every((q) => q.body.name === '线上群名A【已结项】')).toBe(true)
    expect(channelRow('oc_s76a').name).toBe('线上群名A【已结项】') // 绑定行快照同步
    expect(channelRow('oc_s76b').name).toBe('线上群名A【已结项】')
    expect(ctx.db.prepare("SELECT 1 FROM audit_logs WHERE action = 'project.chat.close_mark' AND object_id = ?").get(String(p.id))).toBeTruthy()
  })

  it('S76-1: 提议确认卡与机器人一条链同口径——确认生效响应带 chatCloseMark；机器人终态通知播报群名标记一行', async () => {
    await boot()
    // ① 确认卡入口
    const p1 = await primeProject(ctx.db, 'S76乙项目', { groupKey: 'oc_s76p' })
    stubChatRename({ currentName: '乙项目群' })
    const proposal = createProposal(ctx.db, { kind: 'close_project', payload: { projectId: p1.id, summary: '验收通过' }, summary: '结项', proposedBy: ctx.members.lead.id })
    const confirmed = await confirmProposal(ctx.db, proposal.id, ctx.members.admin.id)
    expect(confirmed.chatCloseMark).toContain('乙项目群【已结项】')
    expect(channelRow('oc_s76p').name).toBe('乙项目群【已结项】')
    // ② 机器人一条链（未绑知识页 → 跳过汇总直接结项，回执即终态通知）
    const p2 = await primeProject(ctx.db, 'S76丙项目', { groupKey: 'oc_s76bot' })
    stubChatRename({ currentName: '丙项目群' })
    const rec = makeRecorder()()
    const factory = makeMsgFactory('om_s76')
    const s = scriptedLlm('{"action":"write","kind":"close_project","payload":{}}')
    const out = await handleBotEvent(ctx.db, factory.group('fs_zhang', 'oc_s76bot', '@大脑 结项', { mentioned: true }), {
      llm: s.llm, send: rec.send, secret: BOT_SECRET,
    })
    expect(out.result).toBe('replied')
    await waitFor(() => ctx.db.prepare('SELECT status FROM projects WHERE id = ?').get(p2.id)?.status === 'closed')
    expect(sentText(rec.sent[0])).toContain('专题群名已标记') // 回执（终态通知）播报群名标记一行
    expect(sentText(rec.sent[0])).toContain('丙项目群【已结项】')
    expect(channelRow('oc_s76bot').name).toBe('丙项目群【已结项】')
  })

  it('S76-2: 幂等（已带标记零改名请求）；只绑通用群/未绑飞书群零请求；取消项目（cancelled）不标记', async () => {
    await boot()
    // 幂等：群名已带【已结项】→ 不发 PUT
    const p1 = await primeProject(ctx.db, 'S76幂等项目', { groupKey: 'oc_s76i' })
    const { puts } = stubChatRename({ currentName: '幂等群【已结项】' })
    expect(await chatCloseMarkNotice(ctx.db, p1.id, ctx.members.admin.id)).toBeNull()
    expect(puts).toHaveLength(0)
    // 只在通用群（general 不绑项目，结构性不标记）与未绑群项目：连群信息都不取
    upsertChannel(ctx.db, { platform: 'feishu', groupKey: 'oc_s76g', channelType: 'general' }, ctx.members.admin.id)
    const p3 = await primeProject(ctx.db, 'S76未绑群项目', {})
    const { urls } = stubChatRename({ currentName: 'X' })
    expect(await chatCloseMarkNotice(ctx.db, p3.id, ctx.members.admin.id)).toBeNull()
    expect(urls.some((u) => u.includes('/im/v1/chats/'))).toBe(false)
    // 取消项目：web 取消响应无 chatCloseMark、零群请求
    const p4 = await primeProject(ctx.db, 'S76取消项目', { groupKey: 'oc_s76c' })
    const before = urls.length
    cancelProject(ctx.db, p4.id, { reason: '需求变化' }, ctx.members.admin.id)
    expect(urls.length).toBe(before)
  })

  it('S76-3: 标记失败（群已解散）不阻断结项、翻人话提示，且不影响知识页标记（K73 各自独立）', async () => {
    const { cookie } = await boot()
    const p = await primeProject(ctx.db, 'S76失败项目', { groupKey: 'oc_s76f' })
    stubChatRename({
      currentName: '失败项目群',
      putResult: { ok: true, json: async () => ({ code: 232009, msg: 'Your request specifies a chat which has already been dissolved.' }) },
    })
    const { bindProjectWiki } = await import('../engine/wiki.js')
    await bindProjectWiki(ctx.db, p.id, { wikiUrl: 'https://x.feishu.cn/wiki/n76' }, ctx.members.admin.id)
    const res = await authed(ctx.app, cookie, 'POST', `/api/v1/projects/${p.id}/close`, { summary: '验收通过' })
    expect(res.status).toBe(200) // 结项照常完成
    expect(res.body.chatCloseMark).toContain('专题群名标记失败')
    expect(res.body.chatCloseMark).toContain('手动改群名')
    expect(res.body.wikiCloseMark).toContain('知识页标题已标记') // K73 不受影响
    expect(ctx.db.prepare('SELECT status FROM projects WHERE id = ?').get(p.id).status).toBe('closed')
    // 飞书凭证未配：同样翻人话不抛出
    setSetting(ctx.db, 'im.feishu', {}, ctx.members.admin.id)
    const notice = await chatCloseMarkNotice(ctx.db, p.id, ctx.members.admin.id)
    expect(notice).toContain('专题群名标记失败')
    expect(notice).toContain('飞书凭证未配置')
  })
})
