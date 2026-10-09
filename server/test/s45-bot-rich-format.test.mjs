import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupApp, loginCookie, authed } from './helpers.mjs'
import { BOT_SECRET as SECRET, scriptedLlm, makeRecorder, makeMsgFactory, mkProject, flattenPost, flattenCard, botRow } from './bot-kit.mjs'
import { handleBotEvent } from '../brain/bot/command.js'
import { richPost } from '../brain/bot/format.js'
import { buildMorningCard, buildTasksInventoryCard } from '../brain/bot/cards.js'
import { upsertChannel } from '../engine/tasks.js'
import { setSetting } from '../engine/settings.js'

// PRD S45（v0.50，design.md K28）— 机器人飞书输出富格式化：
// 文本答复→post 富文本（单行短回执维持 text）、晨报/任务盘点→消息卡片（单项目域多列表格）、
// 卡片/post 失败降级纯文本补发；审计与多轮上下文落完整纯文本；web 端纯文本契约不变。

let ctx
const recorder = makeRecorder()
const { p2p, group } = makeMsgFactory('om_s45')

beforeAll(async () => {
  ctx = await setupApp()
  setSetting(ctx.db, 'im.feishu', { commandQuotaPerDay: 500 }, 1)
})
afterAll(() => ctx?.db.close())

// —— 夹具：引擎返回形状的手工构造（卡片模板是纯函数，不碰库） ——

const morningBlock = (over = {}) => ({
  id: 1, name: '客户M甲系统', status: 'active', statusLabel: '进行中',
  planEndDate: '2026-12-31', remainingDays: 83,
  dueToday: [{ title: '今日发布', responsible: '李四' }],
  overdueTasks: [{ title: '环境搭建', responsible: '李四', planEndDate: '2026-09-25', daysOverdue: 14 }],
  overdueTotal: 1, doingCount: 2, openCount: 5,
  events: [{ type: 'risk', typeLabel: '风险', date: '2026-10-08', summary: '等客户环境', speaker: '张三' }],
  text: '（块文本）',
  ...over,
})

const invTask = (id, over = {}) => ({
  id, title: `任务${id}号`, status: 'todo', statusLabel: '未开始', planEndDate: '2026-10-20', responsibleName: '张三', ...over,
})

const hasColumnSet = (card) => {
  let found = false
  const walk = (n) => {
    if (!n || typeof n !== 'object') return
    if (n.tag === 'column_set') found = true
    for (const v of Object.values(n)) {
      if (Array.isArray(v)) v.forEach(walk)
      else if (v && typeof v === 'object') walk(v)
    }
  }
  walk(card)
  return found
}

describe('S45-1 文本→post 转换器与发送分流', () => {
  it('S45-1: richPost——单行纯文本→null（维持 text）；多行/粗体/链接→post 结构', () => {
    expect(richPost('')).toBeNull()
    expect(richPost(null)).toBeNull()
    expect(richPost('绑定成功，你是「张三」。')).toBeNull() // 单行无标记 → text 维持

    const multi = richPost('第一行\n第二行')
    expect(multi.zh_cn.content).toHaveLength(2) // 换行 → 两个段落

    const bold = richPost('含 **重点** 加粗')
    const runs = bold.zh_cn.content[0]
    const boldRun = runs.find((r) => r.style?.includes('bold'))
    expect(boldRun?.text).toBe('重点')
    expect(flattenPost(bold)).toBe('含 重点 加粗')

    const link = richPost('SOP 见 https://example.com/sop 文档')
    const a = link.zh_cn.content[0].find((r) => r.tag === 'a')
    expect(a?.href).toBe('https://example.com/sop')

    // 未闭合的 ** 不产生粗体 run，标记原样保留（不吞字符）
    const unclosed = richPost('未闭合 **标记')
    expect(unclosed.zh_cn.content[0].some((r) => r.style?.includes('bold'))).toBe(false)
    expect(flattenPost(unclosed)).toBe('未闭合 **标记')
  })

  it('S45-1: LLM 多行答复→post 发送；单行答复→text 维持', async () => {
    const rec1 = recorder()
    const { llm: l1 } = scriptedLlm(JSON.stringify({ action: 'reply', text: '第一行结论\n第二行细节' }))
    const o1 = await handleBotEvent(ctx.db, p2p('fs_zhang', '随便问问45'), { llm: l1, send: rec1.send, secret: SECRET })
    expect(o1.result).toBe('replied')
    expect(rec1.sent[0].text).toBeUndefined()
    expect(flattenPost(rec1.sent[0].post)).toContain('第二行细节')

    const rec2 = recorder()
    const { llm: l2 } = scriptedLlm(JSON.stringify({ action: 'reply', text: '一句话回执。' }))
    await handleBotEvent(ctx.db, p2p('fs_zhang', '再问一句45'), { llm: l2, send: rec2.send, secret: SECRET })
    expect(rec2.sent[0].post).toBeUndefined()
    expect(rec2.sent[0].text).toBe('一句话回执。')
  })

  it('S45-1: 私聊占位按类型原地编辑——多行答案 post→post，单行 text→text（S20-19 语义不变）', async () => {
    const mkPatch = () => {
      const patched = []
      return { patched, patch: async (m) => { patched.push(m); return { ok: true } } }
    }
    // 本地记录器：messageId 挂到出站条目（断言「同一条消息」要比对 id）
    const typedRec = () => {
      const sent = []
      let n = 0
      return { sent, send: async (m) => { const messageId = `bot_s45t_${++n}`; sent.push({ ...m, messageId }); return { messageId } } }
    }
    // 多行答案：占位发出后，同一条消息被编辑为 post
    const rec1 = typedRec()
    const pp1 = mkPatch()
    const { llm: l1 } = scriptedLlm(JSON.stringify({ action: 'reply', text: '结论一\n结论二' }))
    await handleBotEvent(ctx.db, p2p('fs_zhang', '占位多行45'), { llm: l1, send: rec1.send, patch: pp1.patch, secret: SECRET })
    expect(rec1.sent).toHaveLength(1) // 只有占位一条
    expect(rec1.sent[0].text).toContain('正在处理')
    expect(pp1.patched).toHaveLength(1)
    expect(pp1.patched[0].messageId).toBe(rec1.sent[0].messageId)
    expect(pp1.patched[0].text).toBeUndefined()
    expect(flattenPost(pp1.patched[0].post)).toContain('结论二')

    // 单行答案：编辑维持 text
    const rec2 = typedRec()
    const pp2 = mkPatch()
    const { llm: l2 } = scriptedLlm(JSON.stringify({ action: 'reply', text: '单行答案。' }))
    await handleBotEvent(ctx.db, p2p('fs_zhang', '占位单行45'), { llm: l2, send: rec2.send, patch: pp2.patch, secret: SECRET })
    expect(pp2.patched[0].post).toBeUndefined()
    expect(pp2.patched[0].text).toContain('单行答案')
  })
})

describe('S45-2 晨报/盘点卡片模板与双入口契约', () => {
  it('S45-2: 晨报卡片——单项目域出 column_set 多列表；多项目域退化为分节文本行', () => {
    const single = buildMorningCard({ asOf: '2026-10-09', weekday: '四', projects: [morningBlock()], more: 0 })
    expect(single.header.template).toBe('blue')
    expect(single.header.title.content).toContain('项目大脑晨报 2026-10-09')
    expect(hasColumnSet(single)).toBe(true) // 单项目：今日到期/逾期成表
    const flat = flattenCard(single)
    expect(flat).toContain('今日发布')
    expect(flat).toContain('环境搭建')
    expect(flat).toContain('14 天')
    expect(flat).toContain('等客户环境')

    const multi = buildMorningCard({
      asOf: '2026-10-09', weekday: '四', more: 0,
      projects: [morningBlock(), morningBlock({ id: 2, name: '客户M乙系统', dueToday: [], overdueTasks: [], overdueTotal: 0, events: [] })],
    })
    expect(hasColumnSet(multi)).toBe(false) // 多项目：元素预算护栏，一律文本行
    const flatM = flattenCard(multi)
    expect(flatM).toContain('客户M甲系统')
    expect(flatM).toContain('客户M乙系统')
    expect(flatM).toContain('昨日以来无动态')
  })

  it('S45-2: 盘点卡片——单项目 ≤8 行成表、>8 退化文本行；多项目域分节含「均已分配」', () => {
    const small = buildTasksInventoryCard({
      text: '项目「甲项目」任务盘点：未完 3 条，未分配责任人 1 条', unassigned: 1, total: 3,
      scope: 'project', projectName: '甲项目',
      groups: [{ name: '甲项目', sections: [
        { key: 'unassigned', tasks: [invTask(1, { responsibleName: null })] },
        { key: 'owned', tasks: [invTask(2), invTask(3)] },
      ] }],
    })
    expect(small.header.template).toBe('wathet')
    expect(small.header.title.content).toContain('甲项目')
    expect(hasColumnSet(small)).toBe(true)
    const flatS = flattenCard(small)
    expect(flatS).toContain('#1 任务1号')
    expect(flatS).toContain('未指派')

    const big = buildTasksInventoryCard({
      text: '项目「乙项目」任务盘点：未完 10 条，未分配责任人 10 条', unassigned: 10, total: 10,
      scope: 'project', projectName: '乙项目',
      groups: [{ name: '乙项目', sections: [
        { key: 'unassigned', tasks: Array.from({ length: 10 }, (_, i) => invTask(i + 1, { responsibleName: null })) },
      ] }],
    })
    expect(hasColumnSet(big)).toBe(false) // 超 8 行退化文本行
    expect(flattenCard(big)).toContain('#10 任务10号')

    const globalInv = buildTasksInventoryCard({
      text: '在跑项目未分配责任人任务盘点：2 个在跑项目，未分配 1 条', unassigned: 1, totalProjects: 2,
      scope: 'all',
      groups: [
        { name: '甲项目', sections: [{ key: 'plain', tasks: [invTask(1, { responsibleName: null })] }] },
        { name: '乙项目', sections: [{ key: 'plain', tasks: [] }] },
      ],
    })
    expect(hasColumnSet(globalInv)).toBe(false)
    const flatG = flattenCard(globalInv)
    expect(flatG).toContain('甲项目')
    expect(flatG).toContain('乙项目')
    expect(flatG).toContain('均已分配')
  })

  it('S45-2: 专题群 /morning 与 /tasks 出卡片；web 端同一命令仍收纯文本', async () => {
    const p = await mkProject(ctx, '富格式甲项目', ctx.members.lead.id)
    ctx.db.prepare(`UPDATE tasks SET responsible_member_id = NULL WHERE id = (SELECT id FROM tasks WHERE project_id = ? ORDER BY id LIMIT 1)`).run(p.id)
    upsertChannel(ctx.db, { platform: 'feishu', groupKey: 'oc_s45_g', name: '富格式群', channelType: 'dedicated', projectId: p.id }, ctx.members.admin.id)

    const rec1 = recorder()
    const o1 = await handleBotEvent(ctx.db, { ...group('fs_zhang', 'oc_s45_g', '/morning'), mentioned: true }, { send: rec1.send, secret: SECRET })
    expect(o1.result).toBe('replied')
    expect(rec1.sent[0].text).toBeUndefined()
    expect(flattenCard(rec1.sent[0].card)).toContain('富格式甲项目')
    expect(flattenCard(rec1.sent[0].card)).toContain('项目大脑晨报')

    const rec2 = recorder()
    const o2 = await handleBotEvent(ctx.db, { ...group('fs_zhang', 'oc_s45_g', '/tasks'), mentioned: true }, { send: rec2.send, secret: SECRET })
    expect(o2.result).toBe('replied')
    expect(flattenCard(rec2.sent[0].card)).toContain('富格式甲项目')
    expect(flattenCard(rec2.sent[0].card)).toContain('未分配')

    // web 契约：同一命令在 web AI 助手仍收纯文本（K12 双入口，卡片只是 IM 适配器渲染）
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const sid = (await authed(ctx.app, cookie, 'POST', '/api/v1/chat/sessions', {})).body.id
    const slash = await authed(ctx.app, cookie, 'POST', `/api/v1/chat/sessions/${sid}/messages`, { text: '/morning' })
    expect(slash.status).toBe(200)
    expect(typeof slash.body.assistant.content).toBe('string')
    expect(slash.body.assistant.content).toContain('项目大脑晨报')
    expect(slash.body.assistant.card).toBeUndefined()
  })
})

describe('S45-3 必达兜底与审计口径', () => {
  it('S45-3: 卡片发送失败降级纯文本补发；bot_reply 审计落完整纯文本', async () => {
    const p = await mkProject(ctx, '兜底甲项目', ctx.members.lead.id)
    upsertChannel(ctx.db, { platform: 'feishu', groupKey: 'oc_s45_fb', name: '兜底群', channelType: 'dedicated', projectId: p.id }, ctx.members.admin.id)
    const sent = []
    let seq = 0
    const send = async (m) => {
      if (m.card) throw new Error('卡片被拒（模拟飞书报错）')
      const messageId = `bot_s45fb_${++seq}`
      sent.push({ ...m, messageId })
      return { messageId }
    }
    const out = await handleBotEvent(ctx.db, { ...group('fs_zhang', 'oc_s45_fb', '/morning'), mentioned: true }, { send, secret: SECRET })
    expect(out.result).toBe('replied')
    expect(sent).toHaveLength(1) // 卡片失败后纯文本补发同内容
    expect(sent[0].text).toContain('项目大脑晨报')
    expect(sent[0].text).toContain('兜底甲项目')
    // 审计：bot_reply 落完整纯文本（卡片场景同样）
    const row = botRow(ctx, sent[0].messageId)
    expect(row.kind).toBe('bot_reply')
    expect(row.raw_text).toContain('项目大脑晨报')
    expect(row.raw_text).toContain('兜底甲项目')
  })

  it('S45-3: post 发送失败降级 text 补发；卡片成功时审计也是完整纯文本', async () => {
    // post 失败兜底
    const { llm } = scriptedLlm(JSON.stringify({ action: 'reply', text: '第一行\n第二行' }))
    const sent = []
    let seq = 0
    const send = async (m) => {
      if (m.post) throw new Error('post 被拒（模拟）')
      sent.push(m)
      return { messageId: `bot_s45p_${++seq}` }
    }
    const out = await handleBotEvent(ctx.db, p2p('fs_zhang', 'post 兜底45'), { llm, send, secret: SECRET })
    expect(out.result).toBe('replied')
    expect(sent).toHaveLength(1)
    expect(sent[0].text).toContain('第二行')

    // 卡片成功：审计行 raw_text = 引擎完整纯文本（本地记录器把 messageId 挂到出站条目）
    const sent2 = []
    let seq2 = 0
    const send2 = async (m) => { const messageId = `bot_s45a_${++seq2}`; sent2.push({ ...m, messageId }); return { messageId } }
    await handleBotEvent(ctx.db, p2p('fs_zhang', '/morning'), { send: send2, secret: SECRET })
    const row = botRow(ctx, sent2[0].messageId)
    expect(row.kind).toBe('bot_reply')
    expect(row.raw_text).toContain('项目大脑晨报')
  })
})
