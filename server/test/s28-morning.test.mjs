import { describe, it, expect, afterAll } from 'vitest'
import { setupApp, loginCookie, authed } from './helpers.mjs'
import { morningReport } from '../engine/morning.js'
import { addEvent } from '../engine/events.js'
import { upsertChannel } from '../engine/tasks.js'
import { handleBotEvent } from '../brain/bot/command.js'
import { flattenCard } from './bot-kit.mjs'

// PRD S28（v0.27）— 今日晨报：按会话自动定域（专题群=本群项目；私聊/web=全部在跑项目）
// engine 确定性组装（北京日窗：昨日零点起），/morning 斜杠零 LLM，NL 走 morning 读侧动作。

const SECRET = 's28-test-bot-hmac-secret-32-bytes!'
const NOW = Date.UTC(2026, 9, 2, 1, 0, 0) // 2026-10-02 09:00 北京（星期五）
const DAY = 86_400_000

let ctx
afterAll(() => ctx?.db.close())

let msgSeq = 0
let replySeq = 0
const nextMsgId = () => `om_s28_${++msgSeq}`

function scriptedLlm(...actions) {
  const calls = []
  return {
    calls,
    llm: {
      name: 'fake',
      complete: async (messages) => {
        calls.push(messages)
        return String(actions.shift() ?? '{"action":"reply","text":"（脚本耗尽）"}')
      },
    },
  }
}

const recorder = () => {
  const sent = []
  return { sent, send: async (m) => { sent.push(m); return { messageId: `bot_s28_${++replySeq}` } } }
}

const p2p = (openId, text) => ({ messageId: nextMsgId(), chatId: 'oc_s28_p2p', chatType: 'p2p', senderOpenId: openId, text, ts: Date.now() })
const group = (openId, chatId, text) => ({ messageId: nextMsgId(), chatId, chatType: 'group', senderOpenId: openId, text, ts: Date.now() })

async function seed() {
  const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
  const mk = (name, extra = {}) =>
    authed(ctx.app, cookie, 'POST', '/api/v1/projects', { name, templateCode: 'lianmai_365', leadMemberId: ctx.members.lead.id, ...extra })
  const a = (await mk('客户M甲系统', { planEndDate: '2026-12-31' })).body
  const b = (await mk('客户M乙系统', {})).body
  // 立项 decision 事件 business_time=真实时刻（在窗口内），推出窗口保证「无动态」断言确定
  ctx.db.prepare('UPDATE project_events SET business_time = ? WHERE business_time > ?').run(NOW - 10 * DAY, NOW)
  const now = Date.now()
  const ins = (pid, title, status, ps, pe, resp) => Number(ctx.db.prepare(
    `INSERT INTO tasks (project_id, title, responsible_member_id, status, plan_start_date, plan_end_date, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'manual', ?, ?)`
  ).run(pid, title, resp, status, ps, pe, now, now).lastInsertRowid)

  // 甲：active，模板任务清日期，插 今日到期/逾期/进行中 三条 + 窗口内外事件
  ctx.db.prepare(`UPDATE tasks SET status = 'todo', plan_start_date = NULL, plan_end_date = NULL WHERE project_id = ?`).run(a.id)
  ins(a.id, '今日发布', 'todo', '2026-10-01', '2026-10-02', ctx.members.dev.id)
  ins(a.id, '环境搭建', 'todo', '2026-09-20', '2026-09-25', ctx.members.dev.id)
  ins(a.id, '接口联调', 'doing', '2026-10-01', '2026-10-20', ctx.members.dev.id)
  ctx.db.prepare(`UPDATE projects SET status = 'active' WHERE id = ?`).run(a.id)
  addEvent(ctx.db, { projectId: a.id, businessTime: NOW - 12 * DAY / 24, eventType: 'progress', summary: '联调完成 80%', speakerMemberId: ctx.members.dev.id, speakerLabel: '李四', generatedBy: 'extraction' })
  addEvent(ctx.db, { projectId: a.id, businessTime: NOW - 1 * DAY / 24, eventType: 'risk', summary: '等客户环境', speakerMemberId: ctx.members.lead.id, speakerLabel: '张三', generatedBy: 'extraction' })
  addEvent(ctx.db, { projectId: a.id, businessTime: NOW - 3 * DAY, eventType: 'progress', summary: '老进展不进窗口', generatedBy: 'extraction' })
  return { a, b, cookie }
}

describe('S28 今日晨报', () => {
  it('S28-1: engine morningReport——全部在跑项目块结构（今日到期/逾期/进行中/昨日以来窗口）', async () => {
    ctx = await setupApp()
    const { a, b } = await seed()

    const r = morningReport(ctx.db, { now: NOW })
    expect(r.projects.map((p) => p.name)).toEqual(['客户M甲系统', '客户M乙系统']) // 优先级同档，有交付日者在前
    expect(r.text).toContain('项目大脑晨报 2026-10-02（星期五）')

    const blk = r.projects[0]
    expect(blk.status).toBe('active')
    expect(blk.remainingDays).toBe(90)
    expect(blk.dueToday).toHaveLength(1)
    expect(blk.dueToday[0]).toMatchObject({ title: '今日发布', responsible: '李四' })
    expect(blk.overdueTotal).toBe(1)
    expect(blk.overdueTasks[0]).toMatchObject({ title: '环境搭建', responsible: '李四', daysOverdue: 7 })
    expect(blk.doingCount).toBe(1)
    expect(blk.events.map((e) => e.summary)).toEqual(['等客户环境', '联调完成 80%']) // 倒序；3 天前的不进窗口
    expect(blk.events[0]).toMatchObject({ type: 'risk', speaker: '张三' })

    const silent = r.projects[1]
    expect(silent.events).toEqual([])
    expect(silent.text).toContain('昨日以来无动态')

    // 单项目 / 不存在
    expect(morningReport(ctx.db, { projectId: a.id, now: NOW }).projects).toHaveLength(1)
    expect(() => morningReport(ctx.db, { projectId: 99999, now: NOW })).toThrow(/项目不存在/)
    // 已结项项目不出现在全量晨报
    ctx.db.prepare(`UPDATE projects SET status = 'closed' WHERE id = ?`).run(b.id)
    expect(morningReport(ctx.db, { now: NOW }).projects.map((p) => p.id)).toEqual([a.id])
  })

  it('S28-1: 私聊 /morning——全部在跑项目晨报，零 LLM（不传 llm 也能回）', async () => {
    ctx = await setupApp()
    await seed()
    // v0.50（S45）：晨报出口为消息卡片（私聊同群聊），内容口径不变——断言拍平卡片文本
    const rec = recorder()
    const out = await handleBotEvent(ctx.db, p2p('fs_zhang', '/morning'), { send: rec.send, secret: SECRET })
    expect(out.result).toBe('replied')
    const flat = flattenCard(rec.sent[0].card)
    expect(flat).toContain('项目大脑晨报')
    expect(flat).toContain('客户M甲系统')
    expect(flat).toContain('客户M乙系统')
    // 别名 /晨报 与 /today 等价
    const rec2 = recorder()
    await handleBotEvent(ctx.db, p2p('fs_zhang', '/晨报'), { send: rec2.send, secret: SECRET })
    expect(flattenCard(rec2.sent[0].card)).toContain('项目大脑晨报')
    // 未绑定成员：项目数据不漏，回绑定引导
    const rec3 = recorder()
    const g = await handleBotEvent(ctx.db, p2p('fs_stranger', '/morning'), { send: rec3.send, secret: SECRET })
    expect(g.result).toBe('guidance')
    expect(rec3.sent[0].text).toContain('/bind')
  })

  it('S28-2: 专题群 /morning——只发本群绑定项目的晨报；通用群与私聊同域', async () => {
    ctx = await setupApp()
    const { a } = await seed()
    upsertChannel(ctx.db, { platform: 'feishu', groupKey: 'oc_s28_g', name: '甲项目群', channelType: 'dedicated', projectId: a.id })
    const rec = recorder()
    const out = await handleBotEvent(ctx.db, group('fs_zhang', 'oc_s28_g', '/morning'), { send: rec.send, secret: SECRET })
    expect(out.result).toBe('replied')
    // v0.50（S45）：卡片拍平后内容口径不变——只含本群项目
    const flat = flattenCard(rec.sent[0].card)
    expect(flat).toContain('客户M甲系统')
    expect(flat).not.toContain('客户M乙系统')
    // 通用群（已登记 general）：无默认项目 → 与私聊同域（全部在跑项目）
    upsertChannel(ctx.db, { platform: 'feishu', groupKey: 'oc_s28_gen', name: '大群', channelType: 'general' })
    const rec2 = recorder()
    await handleBotEvent(ctx.db, group('fs_zhang', 'oc_s28_gen', '/morning'), { send: rec2.send, secret: SECRET })
    expect(flattenCard(rec2.sent[0].card)).toContain('客户M乙系统')
  })

  it('S28-3: NL 走 morning 读侧动作（计入查询限额）；web 会话两路径一致', async () => {
    ctx = await setupApp()
    await seed()
    // 飞书 NL：工具反馈含整段晨报，queries 计 1
    const { llm, calls } = scriptedLlm(
      JSON.stringify({ action: 'morning' }),
      JSON.stringify({ action: 'reply', text: '已把晨报发你了（见上）。' })
    )
    const rec = recorder()
    const evt = p2p('fs_zhang', '今天的情况汇总一下')
    const out = await handleBotEvent(ctx.db, evt, { llm, send: rec.send, secret: SECRET })
    expect(out.result).toBe('replied')
    expect(calls[1].at(-1).content).toContain('项目大脑晨报')
    expect(calls[1].at(-1).content).toContain('客户M甲系统')
    const row = ctx.db.prepare('SELECT * FROM bot_commands WHERE message_id = ?').get(evt.messageId)
    expect(JSON.parse(row.detail).queries).toBe(1)

    // web：斜杠（无 LLM 配置也可用）+ NL 动作
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const sid = (await authed(ctx.app, cookie, 'POST', '/api/v1/chat/sessions', {})).body.id
    const slash = await authed(ctx.app, cookie, 'POST', `/api/v1/chat/sessions/${sid}/messages`, { text: '/morning' })
    expect(slash.status).toBe(200)
    expect(slash.body.assistant.content).toContain('项目大脑晨报')
    expect(slash.body.assistant.meta).toMatchObject({ result: 'replied' })

    const capture = []
    ctx.app.llm = {
      name: 'fake',
      complete: async (messages) => {
        capture.push(String(messages.at(-1)?.content || ''))
        return capture.length === 1
          ? JSON.stringify({ action: 'morning' })
          : JSON.stringify({ action: 'reply', text: '晨报如上。' })
      },
    }
    const nl = await authed(ctx.app, cookie, 'POST', `/api/v1/chat/sessions/${sid}/messages`, { text: '给我今天的晨报' })
    expect(nl.body.assistant.content).toBe('晨报如上。')
    expect(capture[1]).toContain('项目大脑晨报')
    expect(nl.body.assistant.meta).toMatchObject({ result: 'replied', queries: 1 })
  })
})
