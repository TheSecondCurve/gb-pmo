import { describe, it, expect, afterAll } from 'vitest'
import { setupApp, loginCookie, authed } from './helpers.mjs'
import { projectBrief } from '../engine/brief.js'
import { addEvent } from '../engine/events.js'
import { handleBotEvent } from '../brain/bot/command.js'

// PRD S27（v0.26）— 项目 Brief：engine 确定性组装（北京时区）+ 会话面 brief 动作（飞书/web 一致）
// fake LLM 注入脚本化 JSON 动作；不走真实飞书与真实 LLM（K7：真库 + inject）。

const SECRET = 's27-test-bot-hmac-secret-32-bytes!'
const NOW = Date.UTC(2026, 9, 2, 3, 0, 0) // 2026-10-02 11:00 北京（今天=2026-10-02）
const DAY = 86_400_000

let ctx
afterAll(() => ctx?.db.close())

let msgSeq = 0
let replySeq = 0
const nextMsgId = () => `om_s27_${++msgSeq}`

/** 脚本化 fake LLM：依次弹出动作 JSON，记录收到的 messages（断言工具反馈与 system prompt）。 */
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
  return { sent, send: async (m) => { sent.push(m); return { messageId: `bot_s27_${++replySeq}` } } }
}

const p2p = (openId, text) => ({ messageId: nextMsgId(), chatId: 'oc_s27_p2p', chatType: 'p2p', senderOpenId: openId, text, ts: Date.now() })

/** 造一个盘子已知的项目：模板任务全置 done，另插 4 条已知任务 + 里程碑 + 近期/过期事件。 */
async function seedProject(name) {
  const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
  const p = (await authed(ctx.app, cookie, 'POST', '/api/v1/projects', {
    name, templateCode: 'lianmai_365', leadMemberId: ctx.members.lead.id, planEndDate: '2026-12-31',
  })).body
  const pid = p.id
  const lead = ctx.members.lead.id
  const dev = ctx.members.dev.id

  // 模板任务全部 done（计入盘子，不制造噪音）
  const baseTasks = ctx.db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE project_id = ?').get(pid).n
  ctx.db.prepare(`UPDATE tasks SET status = 'done', actual_end_date = '2026-09-28', responsible_member_id = ? WHERE project_id = ?`).run(lead, pid)

  const insTask = (title, status, ps, pe, resp) => {
    const now = Date.now()
    return Number(ctx.db.prepare(
      `INSERT INTO tasks (project_id, title, responsible_member_id, status, plan_start_date, plan_end_date, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'manual', ?, ?)`
    ).run(pid, title, resp, status, ps, pe, now, now).lastInsertRowid)
  }
  const insMs = (name2, planDate, status = 'planned') => {
    const now = Date.now()
    ctx.db.prepare(
      `INSERT INTO milestones (project_id, name, plan_date, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(pid, name2, planDate, status, now, now)
  }

  // 4 条已知任务：1 doing / 1 未来最近 todo / 1 逾期 todo / 1 远期 todo
  insTask('接口联调', 'doing', '2026-10-01', '2026-10-20', dev)
  insTask('UAT 准备', 'todo', '2026-10-05', '2026-10-15', lead)
  insTask('环境搭建', 'todo', '2026-09-20', '2026-09-25', dev) // 逾期 7 天
  insTask('验收材料', 'todo', '2026-11-10', '2026-12-20', lead)
  insMs('UAT 验收', '2026-10-20')
  insMs('立项评审', '2026-09-15', 'met')

  // 事件：近期进展 / 窗口外老进展 / 近期风险 / 窗口外老阻塞 / pending 建议（不进 brief）
  // 立项 decision 事件 business_time=真实时刻（晚于固定 NOW），归一化到固定过去，保证沉默天数断言确定
  ctx.db.prepare(`UPDATE project_events SET business_time = ? WHERE project_id = ? AND business_time > ?`).run(NOW - 5 * DAY, pid, NOW)
  addEvent(ctx.db, { projectId: pid, businessTime: NOW - 2 * DAY, eventType: 'progress', summary: '联调完成 80%', speakerMemberId: dev, speakerLabel: '李四', generatedBy: 'extraction' })
  addEvent(ctx.db, { projectId: pid, businessTime: NOW - 20 * DAY, eventType: 'progress', summary: '老进展不进窗口', generatedBy: 'extraction' })
  addEvent(ctx.db, { projectId: pid, businessTime: NOW - 1 * DAY, eventType: 'decision', summary: '决策换消息队列', generatedBy: 'extraction' })
  addEvent(ctx.db, { projectId: pid, businessTime: NOW - 3 * DAY, eventType: 'risk', summary: '等客户测试环境', speakerMemberId: lead, speakerLabel: '张三', generatedBy: 'extraction' })
  addEvent(ctx.db, { projectId: pid, businessTime: NOW - 40 * DAY, eventType: 'blocker', summary: '老阻塞不进窗口', generatedBy: 'extraction' })
  addEvent(ctx.db, { projectId: pid, businessTime: NOW - 1 * DAY, nature: 'suggestion', eventType: 'risk', summary: 'pending 建议不进', generatedBy: 'digest' })

  return { pid, lead, dev, baseTasks, cookie }
}

describe('S27 项目 Brief', () => {
  it('S27-2: engine projectBrief——确定性组装六段结构（北京时区窗口 + S21 天数口径 + 截断附总数）', async () => {
    ctx = await setupApp()
    const { pid, lead, dev, baseTasks } = await seedProject('客户S27甲系统')

    const brief = projectBrief(ctx.db, pid, { now: NOW })
    expect(brief.project).toMatchObject({ id: pid, name: '客户S27甲系统', lead: '张三', planEndDate: '2026-12-31', remainingDays: 90 })
    expect(brief.project.statusLabel).toBeTruthy()

    // 盘子：模板 baseTasks 全 done + 4 条已知（1 doing / 3 todo，其中 1 逾期）
    expect(brief.tasks).toMatchObject({ total: baseTasks + 4, done: baseTasks, doing: 1, todo: 3, overdue: 1 })
    expect(brief.tasks.completionRate).toBeCloseTo(baseTasks / (baseTasks + 4), 4)

    // 进行中：标题+责任人+计划起止
    expect(brief.doing).toHaveLength(1)
    expect(brief.doing[0]).toMatchObject({ title: '接口联调', responsible: '李四', planStartDate: '2026-10-01', planEndDate: '2026-10-20' })

    // 下一步：未来计划开始日最近的 todo（2026-10-05）+ 最近 planned 里程碑（过去的 met 不算）
    expect(brief.next.task).toMatchObject({ title: 'UAT 准备', planStartDate: '2026-10-05' })
    expect(brief.next.milestone).toMatchObject({ name: 'UAT 验收', planDate: '2026-10-20' })

    // 近期进展：近 14 天已生效 progress（1 条），窗口外/pending/非 progress 不进
    expect(brief.recentProgress.map((r) => r.summary)).toEqual(['联调完成 80%'])
    expect(brief.recentProgress[0]).toMatchObject({ date: '2026-09-30', speaker: '李四' })
    expect(brief.recentProgressTotal).toBe(1)

    // 风险：逾期任务（超期天数 S21 口径）+ 近 30 天已生效 risk/blocker（窗口外与 pending 不进）
    expect(brief.risks.overdueTasks).toHaveLength(1)
    expect(brief.risks.overdueTasks[0]).toMatchObject({ title: '环境搭建', responsible: '李四', planEndDate: '2026-09-25', daysOverdue: 7 })
    expect(brief.risks.events.map((e) => e.summary)).toEqual(['等客户测试环境'])
    expect(brief.risks.events[0]).toMatchObject({ type: 'risk', speaker: '张三' })

    // 活跃度：最后已生效事件 = 昨天的 decision
    expect(brief.activity.silentDays).toBe(1)

    // 项目不存在：明确 404 语义
    expect(() => projectBrief(ctx.db, 99999, { now: NOW })).toThrow(/项目不存在/)
  })

  it('S27-1: 飞书会话——整体问询优先 brief 动作一次取全，基于取回数据叙述；计入查询限额', async () => {
    ctx = await setupApp()
    const { pid } = await seedProject('客户S27乙系统')
    const { llm, calls } = scriptedLlm(
      JSON.stringify({ action: 'brief', projectId: pid }),
      JSON.stringify({ action: 'reply', text: '【客户S27乙系统 Brief】进行中 1 项，逾期 1 项，风险 1 条。' })
    )
    const rec = recorder()
    const evt = p2p('fs_zhang', '客户S27乙系统现在怎么样？给个 Brief')
    const out = await handleBotEvent(ctx.db, evt, { llm, send: rec.send, secret: SECRET })
    expect(out.result).toBe('replied')
    expect(rec.sent[0].text).toContain('Brief')
    // system prompt：声明 brief 动作与优先级
    expect(calls[0][0].content).toContain('"action":"brief"')
    expect(calls[0][0].content).toContain('优先')
    // 工具反馈：brief 数据回灌给 LLM（先查后答的依据）
    expect(calls[1].at(-1).content).toContain('客户S27乙系统')
    expect(calls[1].at(-1).content).toContain('联调完成 80%')
    // brief 与 query/metric 同属读侧：审计 detail.queries 计 1 次
    const row = ctx.db.prepare('SELECT * FROM bot_commands WHERE message_id = ?').get(evt.messageId)
    expect(JSON.parse(row.detail).queries).toBe(1)
    expect(row.llm_calls).toBe(2)

    // 项目不存在：取数失败反馈给 LLM，由其明说
    const miss = scriptedLlm(
      JSON.stringify({ action: 'brief', projectId: 99999 }),
      JSON.stringify({ action: 'reply', text: '没找到这个项目，请确认项目名或 id。' })
    )
    const rec2 = recorder()
    const out2 = await handleBotEvent(ctx.db, p2p('fs_zhang', '项目 99999 怎么样'), { llm: miss.llm, send: rec2.send, secret: SECRET })
    expect(out2.result).toBe('replied')
    expect(miss.calls[1].at(-1).content).toContain('项目不存在')
    expect(rec2.sent[0].text).toContain('没找到')
  })

  it('S27-3: web 会话——同一 brief 动作（统一管线一次注册，两入口一致）', async () => {
    ctx = await setupApp()
    const { pid, cookie } = await seedProject('客户S27丙系统')
    const sid = (await authed(ctx.app, cookie, 'POST', '/api/v1/chat/sessions', {})).body.id

    const capture = []
    ctx.app.llm = {
      name: 'fake',
      complete: async (messages) => {
        capture.push(messages.map((m) => m.role).concat(String(messages.at(-1)?.content || '')))
        const step = capture.length
        if (step === 1) return JSON.stringify({ action: 'brief', projectId: pid })
        return JSON.stringify({ action: 'reply', text: '【客户S27丙系统 Brief】盘子 4+，近期进展 1 条。' })
      },
    }
    const res = await authed(ctx.app, cookie, 'POST', `/api/v1/chat/sessions/${sid}/messages`, { text: '客户S27丙系统整体情况如何' })
    expect(res.status).toBe(200)
    expect(res.body.assistant.content).toContain('客户S27丙系统')
    // 工具反馈含 brief 数据（engine 同源）+ brief 计入查询数
    expect(capture[1].join(' ')).toContain('客户S27丙系统')
    expect(res.body.assistant.meta).toMatchObject({ result: 'replied', llmCalls: 2, queries: 1 })
  })
})
