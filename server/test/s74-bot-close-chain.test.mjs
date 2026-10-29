import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { setupApp, waitFor } from './helpers.mjs'
import { createProject } from '../engine/projects.js'
import { setSetting } from '../engine/settings.js'
import { upsertChannel } from '../engine/tasks.js'
import { bindProjectWiki } from '../engine/wiki.js'
import { handleBotEvent } from '../brain/bot/command.js'
import { runWriteTool } from '../brain/bot/tools.js'
import { scriptedLlm, makeRecorder, makeMsgFactory, flattenPost, BOT_SECRET } from './bot-kit.mjs'

// PRD S74（v0.86，K71）— 机器人结项一条链：免理由 + 自动补项目汇总 + 群内步骤播报：
// IM 面 write kind=close_project 直效（权限牵头人/管理员 + S8 前置 + 绑页未归档先补汇总），
// 汇总完成自动 closeProject（总结自动组装：口述 > 汇总链接 > 兜底），终态通知含可解散本群与祝福；
// 取消项目仍走确认卡；web 会话（无 push）回落提议口径（S25/S29 不变）。

let ctx
beforeAll(async () => {
  ctx = await setupApp()
  setSetting(ctx.db, 'im.feishu', { appId: 'a', appSecret: 's' }, ctx.members.admin.id)
})
afterAll(() => ctx?.db.close())
const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

const okJson = (data) => ({ ok: true, json: async () => ({ code: 0, data }) })
const sentText = (m) => m.text ?? (m.post ? flattenPost(m.post) : '') // 多行回执走 post 富文本（S45 分流）

/** 建项目（任务按类型清单实例化）+ 绑知识页 + 绑专题群；markDone 时任务全置 done。 */
async function prime(name, groupKey, { markDone = true, kind } = {}) {
  const p = createProject(ctx.db, { name, typeCode: 'lianmai_365', leadMemberId: ctx.members.lead.id, ...(kind ? { kind } : {}) }, ctx.members.admin.id)
  globalThis.fetch = async (rawUrl) => {
    const url = String(rawUrl)
    if (url.includes('tenant_access_token')) return { ok: true, json: async () => ({ code: 0, tenant_access_token: 'tok' }) }
    if (url.includes('/wiki/v2/spaces/get_node')) return okJson({ node: { node_token: 'parenttok', obj_token: 'pdoc', obj_type: 'docx', title: '父页', space_id: 'sp1' } })
    if (url.includes('/wiki/v2/spaces/sp1/nodes')) return okJson({ node: { node_token: 'np_s74', obj_token: 'docs74', obj_type: 'docx', title: '页', space_id: 'sp1' } })
    return okJson({})
  }
  await bindProjectWiki(ctx.db, p.id, { parentNodeToken: 'parenttok', newTitle: `${name}页` }, ctx.members.admin.id)
  upsertChannel(ctx.db, { platform: 'feishu', groupKey, channelType: 'dedicated', projectId: p.id }, ctx.members.admin.id)
  if (markDone) ctx.db.prepare("UPDATE tasks SET status = 'done' WHERE project_id = ?").run(p.id)
  return p
}

/** 归档执行 fetch 桩（同 s73 口径：1 条群消息、空页、插入成功；insertFail 驱动汇总失败）。 */
function stubArchiveRun({ insertFail } = {}) {
  globalThis.fetch = async (rawUrl, opts = {}) => {
    const url = String(rawUrl)
    if (url.includes('tenant_access_token')) return { ok: true, json: async () => ({ code: 0, tenant_access_token: 'tok' }) }
    if (url.includes('/im/v1/messages')) {
      return okJson({ items: [{ message_id: 'm1', create_time: String(Math.floor(Date.now() / 1000) - 60), msg_type: 'text', sender: { id: 'fs_zhang', sender_type: 'user' }, body: { content: JSON.stringify({ text: '项目收官，感谢大家' }) } }], has_more: false })
    }
    if (url.includes('/docx/v1/documents/') && url.includes('/children')) {
      if ((opts.method ?? 'GET') === 'GET') return okJson({ items: [], has_more: false })
      if (insertFail) return { ok: true, json: async () => ({ code: 1770001, msg: 'invalid param' }) }
      return okJson({ children: [{ block_id: 'gen1' }] })
    }
    return okJson({})
  }
}

const projRow = (id) => ctx.db.prepare('SELECT status, closeout_summary FROM projects WHERE id = ?').get(id)
const archiveRuns = (id) => ctx.db.prepare('SELECT COUNT(*) AS n FROM wiki_archive_runs WHERE project_id = ?').get(id).n

async function triggerClose(groupKey, { text = '@大脑 结项', payload = '{}', name = 'om_s74' } = {}) {
  const rec = makeRecorder()()
  const factory = makeMsgFactory(name)
  const s = scriptedLlm(`{"action":"write","kind":"close_project","payload":${payload}}`)
  const out = await handleBotEvent(ctx.db, factory.group('fs_zhang', groupKey, text, { mentioned: true }), {
    llm: s.llm, send: rec.send, secret: BOT_SECRET,
  })
  return { out, rec }
}

describe('S74 机器人结项一条链', () => {
  it('S74-1: 牵头人 @结项（绑页+群、无归档、任务全完成）——回执步骤① → 汇总完成播报 → 自动结项 → 终态通知', async () => {
    const p = await prime('S74甲项目', 'oc_s74_a')
    stubArchiveRun({})
    const { out, rec } = await triggerClose('oc_s74_a', { name: 'om_s74a' })
    expect(out.result).toBe('replied')
    expect(sentText(rec.sent[0])).toContain('①')
    expect(sentText(rec.sent[0])).toContain('生成项目汇总')
    await waitFor(() => projRow(p.id)?.status === 'closed' && rec.sent.length >= 3, { timeoutMs: 3000 })
    // 步骤播报：② 汇总完成带链接；③ 终态通知
    expect(sentText(rec.sent[1])).toContain('汇总已生成')
    expect(sentText(rec.sent[1])).toContain('https://feishu.cn/wiki/np_s74')
    const final = sentText(rec.sent[2])
    expect(final).toContain('已结项')
    expect(final).toContain('https://feishu.cn/wiki/np_s74')
    expect(final).toContain('解散')
    expect(final).toContain('顺利')
    // 结项落库：closeout_summary 自动组装（汇总链接）；事件 + 审计留痕
    expect(projRow(p.id).closeout_summary).toContain('https://feishu.cn/wiki/np_s74')
    expect(ctx.db.prepare(`SELECT 1 FROM project_events WHERE project_id = ? AND summary LIKE '%项目结项%'`).get(p.id)).toBeTruthy()
    expect(ctx.db.prepare(`SELECT 1 FROM audit_logs WHERE action = 'project.close' AND object_id = ?`).get(String(p.id))).toBeTruthy()
    expect(archiveRuns(p.id)).toBe(1)
  })

  it('S74-2: 已生成过汇总 → 跳过①直接结项；口述总结优先；无口述时自动组装（链接优先）', async () => {
    const p = await prime('S74乙项目', 'oc_s74_b')
    ctx.db.prepare("INSERT INTO wiki_archive_runs (project_id, status, stage, page_url, finished_at, created_at) VALUES (?, 'done', 'done', 'https://feishu.cn/wiki/existing', ?, ?)").run(p.id, Date.now(), Date.now())
    stubArchiveRun({}) // 即使 stub 在，也不应再触发归档
    const { out, rec } = await triggerClose('oc_s74_b', { payload: '{"summary":"客户验收通过，顺利交付"}', name: 'om_s74b' })
    expect(out.result).toBe('replied')
    expect(rec.sent.length).toBe(1) // 直接终态回复，无步骤播报
    const final = sentText(rec.sent[0])
    expect(final).toContain('已结项')
    expect(final).toContain('https://feishu.cn/wiki/existing') // 既有汇总链接进终态消息
    expect(projRow(p.id).closeout_summary).toBe('客户验收通过，顺利交付') // 口述优先
    expect(archiveRuns(p.id)).toBe(1) // 未新增归档
  })

  it('S74-3: 常态项目/未绑知识页 → 跳过汇总直接结项（常态豁免任务完成检查 S69）', async () => {
    const routine = createProject(ctx.db, { name: 'S74常态项目', typeCode: 'lianmai_365', leadMemberId: ctx.members.lead.id, kind: 'routine' }, ctx.members.admin.id)
    upsertChannel(ctx.db, { platform: 'feishu', groupKey: 'oc_s74_r', channelType: 'dedicated', projectId: routine.id }, ctx.members.admin.id)
    const r1 = await triggerClose('oc_s74_r', { name: 'om_s74c' })
    expect(r1.out.result).toBe('replied')
    expect(projRow(routine.id).status).toBe('closed') // 常态任务未全 done 也结项成功（S69）
    expect(archiveRuns(routine.id)).toBe(0)
    expect(sentText(r1.rec.sent[0])).toContain('解散')

    // 未绑知识页的交付项目（任务全完成）→ 直接结项，兜底总结文案
    const bare = createProject(ctx.db, { name: 'S74未绑页项目', typeCode: 'lianmai_365', leadMemberId: ctx.members.lead.id }, ctx.members.admin.id)
    upsertChannel(ctx.db, { platform: 'feishu', groupKey: 'oc_s74_bare', channelType: 'dedicated', projectId: bare.id }, ctx.members.admin.id)
    ctx.db.prepare("UPDATE tasks SET status = 'done' WHERE project_id = ?").run(bare.id)
    await triggerClose('oc_s74_bare', { name: 'om_s74d' })
    expect(projRow(bare.id).status).toBe('closed')
    expect(archiveRuns(bare.id)).toBe(0)
    expect(projRow(bare.id).closeout_summary).toMatch(/结项/) // 兜底文案（无链接可用）
  })

  it('S74-4: 非牵头人非管理员拒绝；未完成任务拒绝且不触发汇总；终态项目拒绝', async () => {
    const p = await prime('S74丙项目', 'oc_s74_d', { markDone: false })
    const denied = await runWriteTool(ctx.db, { kind: 'close_project', payload: {} }, {
      member: ctx.members.dev, evt: { platform: 'feishu', chatId: 'oc_s74_d', chatType: 'group' },
      llm: { name: 'fake', complete: async () => '{}' }, push: async () => ({ messageId: null }),
    })
    expect(denied.type).toBe('refused')
    expect(denied.text).toMatch(/仅系统管理员或项目牵头人/)

    // 未完成任务（牵头人触发）→ 拒绝且不落归档台账（不白跑汇总）
    const open = await runWriteTool(ctx.db, { kind: 'close_project', payload: {} }, {
      member: ctx.members.lead, evt: { platform: 'feishu', chatId: 'oc_s74_d', chatType: 'group' },
      llm: { name: 'fake', complete: async () => '{}' }, push: async () => ({ messageId: null }),
    })
    expect(open.type).toBe('refused')
    expect(open.text).toMatch(/未完成/)
    expect(archiveRuns(p.id)).toBe(0)

    // 终态项目 → 拒绝（引擎直接结项后重触发；不经结项链，避免误触归档）
    const closed = await prime('S74终态项目', 'oc_s74_t')
    const { closeProject } = await import('../engine/projects.js')
    closeProject(ctx.db, closed.id, { summary: '已交付' }, ctx.members.admin.id)
    const after = await runWriteTool(ctx.db, { kind: 'close_project', payload: { projectId: closed.id } }, {
      member: ctx.members.lead, evt: { platform: 'feishu', chatId: 'oc_s74_t', chatType: 'group' },
      llm: { name: 'fake', complete: async () => '{}' }, push: async () => ({ messageId: null }),
    })
    expect(after.type).toBe('refused')
    expect(after.text).toMatch(/终态|不可逆/)
    expect(projRow(p.id).status).toBe('active') // 原项目仍未结（前置拒绝不触发链）
  })

  it('S74-5: 汇总失败中止结项并提示重试/直接结项；skipSummary 直接结项不落台账', async () => {
    const p = await prime('S74丁项目', 'oc_s74_e')
    stubArchiveRun({ insertFail: true })
    const { rec } = await triggerClose('oc_s74_e', { name: 'om_s74e' })
    await waitFor(() => rec.sent.length >= 2, { timeoutMs: 3000 })
    expect(sentText(rec.sent[1])).toContain('汇总生成失败')
    expect(sentText(rec.sent[1])).toContain('直接结项')
    expect(projRow(p.id).status).toBe('active') // 中止，项目保持进行中

    const { out: skip } = await triggerClose('oc_s74_e', { text: '@大脑 直接结项', payload: '{"skipSummary":true}', name: 'om_s74f' })
    expect(skip.result).toBe('replied')
    expect(projRow(p.id).status).toBe('closed')
    expect(archiveRuns(p.id)).toBe(1) // 仅失败那次落过台账（failed），skipSummary 未新增
    expect(ctx.db.prepare("SELECT status FROM wiki_archive_runs WHERE project_id = ?").get(p.id).status).toBe('failed')
  })

  it('S74-6: web 会话（无 push）回落提议确认卡口径（summary 必填不变）；IM 取消项目仍走确认卡', async () => {
    const p = await prime('S74戊项目', 'oc_s74_f')
    // web：缺 summary → 软校验拒绝（既有口径）
    const noSummary = await runWriteTool(ctx.db, { kind: 'close_project', payload: { projectId: p.id } }, {
      member: ctx.members.lead, evt: { platform: 'web', chatType: 'p2p', chatId: 'web_s74' },
      llm: { name: 'fake', complete: async () => '{}' },
    })
    expect(noSummary.type).toBe('refused')
    expect(noSummary.text).toMatch(/摘要|总结/)
    // web：带 summary → 出确认卡（不直效）
    const card = await runWriteTool(ctx.db, { kind: 'close_project', payload: { projectId: p.id, summary: 'web 面结项' } }, {
      member: ctx.members.lead, evt: { platform: 'web', chatType: 'p2p', chatId: 'web_s74' },
      llm: { name: 'fake', complete: async () => '{}' },
    })
    expect(card.type).toBe('card')
    expect(projRow(p.id).status).toBe('active')

    // IM：取消项目仍出确认卡（K25 不放开）
    const s = scriptedLlm(`{"action":"write","kind":"propose","payload":{"kind":"cancel_project","projectId":${p.id},"reason":"客户取消"}}`)
    const rec = makeRecorder()()
    const out = await handleBotEvent(ctx.db, makeMsgFactory('om_s74g').group('fs_zhang', 'oc_s74_f', '@大脑 取消这个项目，客户取消了', { mentioned: true }), {
      llm: s.llm, send: rec.send, secret: BOT_SECRET,
    })
    expect(out.result).toBe('card_sent')
  })
})
