import { describe, it, expect, afterAll } from 'vitest'
import { setupApp, loginCookie, authed } from './helpers.mjs'
import { createProject } from '../engine/projects.js'
import { upsertChannel } from '../engine/tasks.js'
import { addEvent } from '../engine/events.js'
import { handleBotEvent } from '../brain/bot/command.js'
import { BOT_SECRET, makeRecorder, makeMsgFactory } from './bot-kit.mjs'
import { today, addDays, bjWeekStartMs } from '../db/time.js'

// PRD S53（v0.58，K36）— 确定性斜杠 /my /week /risk：零 LLM、不占限额、未配置也可用

let ctx
afterAll(() => ctx?.db.close())

const monday = today(bjWeekStartMs())
const sunday = addDays(monday, 6)

describe('S53 确定性斜杠命令', () => {
  it('S53-1: /my 返回本人未完任务（逾期标注）+ 明日到期 + 待确认建议计数', async () => {
    ctx = await setupApp()
    const p = createProject(ctx.db, { name: '我的项目', typeCode: 'lianmai_365', leadMemberId: ctx.members.lead.id }, ctx.members.admin.id)
    // 李四：一条逾期 + 一条明天到期；张三：一条正常
    ctx.db.prepare('UPDATE tasks SET responsible_member_id = ?, plan_end_date = ? WHERE id = ?').run(ctx.members.dev.id, addDays(today(), -3), p.tasks[0].id)
    ctx.db.prepare('UPDATE tasks SET responsible_member_id = ?, plan_end_date = ? WHERE id = ?').run(ctx.members.dev.id, addDays(today(), 1), p.tasks[1].id)
    ctx.db.prepare('UPDATE tasks SET responsible_member_id = ?, plan_end_date = ? WHERE id = ?').run(ctx.members.lead.id, addDays(today(), 10), p.tasks[2].id)
    // 李四名下一条待确认建议
    addEvent(ctx.db, {
      projectId: p.id, nature: 'suggestion', eventType: 'status_change', summary: '任务一建议标完成',
      targetTaskId: p.tasks[0].id, targetField: 'status', targetValue: 'done', generatedBy: 'extraction',
    })

    const msg = makeMsgFactory('om_s53')
    const { send, sent } = makeRecorder()()
    await handleBotEvent(ctx.db, msg.p2p('fs_li', '/my'), { send, secret: BOT_SECRET })
    const text = sent[sent.length - 1].text ?? sent[sent.length - 1].post
    const flat = typeof text === 'string' ? text : JSON.stringify(text)
    expect(flat).toContain('未完任务 2 项')
    expect(flat).toContain('逾期 3 天')
    expect(flat).toContain('明日到期')
    expect(flat).toContain('待确认建议 1 条')
    expect(flat).not.toContain('我的项目 #' + p.tasks[2].id) // 张三的任务不在其列
  })

  it('S53-2: /week 定域——专题群只看本群项目，私聊看全部在跑项目；窗口=本北京自然周', async () => {
    const a = createProject(ctx.db, { name: '专题项目', typeCode: 'lianmai_365', leadMemberId: ctx.members.lead.id }, ctx.members.admin.id)
    const b = createProject(ctx.db, { name: '别人项目', typeCode: 'lianmai_365', leadMemberId: ctx.members.dev.id }, ctx.members.admin.id)
    // 本周内到期（今天恒在本周内）+ 本周日一个里程碑；下周到期一条（不应出现）
    ctx.db.prepare('UPDATE tasks SET plan_end_date = ? WHERE id = ?').run(today(), a.tasks[0].id)
    ctx.db.prepare('UPDATE tasks SET plan_end_date = ? WHERE id = ?').run(addDays(sunday, 3), a.tasks[1].id)
    ctx.db.prepare('UPDATE tasks SET plan_end_date = ? WHERE id = ?').run(today(), b.tasks[0].id)
    ctx.db.prepare(`INSERT INTO milestones (project_id, name, plan_date, status, created_at, updated_at) VALUES (?, ?, ?, 'planned', ?, ?)`).run(a.id, '本周验收', sunday, Date.now(), Date.now())
    upsertChannel(ctx.db, { platform: 'feishu', groupKey: 'oc_week', channelType: 'dedicated', projectId: a.id })

    const msg = makeMsgFactory('om_s53w')
    const { send, sent } = makeRecorder()()
    // 专题群：只看本项目（含本周到期任务 + 周日里程碑；下周任务不出现；别人项目不出现）
    await handleBotEvent(ctx.db, msg.group('fs_zhang', 'oc_week', '/week'), { send, secret: BOT_SECRET })
    let flat = JSON.stringify(sent[sent.length - 1])
    expect(flat).toContain('专题项目')
    expect(flat).toContain('本周验收')
    expect(flat).not.toContain('别人项目')
    expect(flat).not.toContain(a.tasks[1].title) // 下周到期不出现
    // 私聊：全部在跑项目
    await handleBotEvent(ctx.db, msg.p2p('fs_zhang', '/本周'), { send, secret: BOT_SECRET })
    flat = JSON.stringify(sent[sent.length - 1])
    expect(flat).toContain('专题项目')
    expect(flat).toContain('别人项目')
  })

  it('S53-3: /risk 全局风险板——逾期/沉默/未指派/过载齐备，空项明确标注', async () => {
    // 造沉默项目（事件压到 10 天前）
    const silent = createProject(ctx.db, { name: '沉睡项目', typeCode: 'lianmai_365', leadMemberId: ctx.members.lead.id }, ctx.members.admin.id)
    const old = Date.now() - 10 * 86400000
    ctx.db.prepare('UPDATE project_events SET business_time = ? WHERE project_id = ?').run(old, silent.id)
    ctx.db.prepare('UPDATE tasks SET updated_at = ? WHERE project_id = ?').run(old, silent.id)
    // 未指派任务（S38：模板实例化默认未指派，沉睡项目全部未指派）

    const msg = makeMsgFactory('om_s53r')
    const { send, sent } = makeRecorder()()
    await handleBotEvent(ctx.db, msg.p2p('fs_zhang', '/risk'), { send, secret: BOT_SECRET })
    const flat = JSON.stringify(sent[sent.length - 1])
    expect(flat).toContain('风险')
    expect(flat).toContain('沉睡项目')
    expect(flat).toContain('沉默')
    expect(flat).toMatch(/未指派|未分配/)
    expect(flat).toContain('关键人')
  })

  it('S53-4: LLM 未配置/限额耗尽照常可用；/help 收录；web 入口同构', async () => {
    // 限额压到 0：斜杠仍可（确定性不占限额）；自然语言被拒
    const { setSetting } = await import('../engine/settings.js')
    setSetting(ctx.db, 'im.feishu', { commandQuotaPerDay: 0 })
    const msg = makeMsgFactory('om_s53z')
    const { send, sent } = makeRecorder()()
    await handleBotEvent(ctx.db, msg.p2p('fs_zhang', '/my'), { send, secret: BOT_SECRET }) // 无 LLM 配置
    expect(JSON.stringify(sent[sent.length - 1])).toContain('未完任务')
    // /help 收录新命令
    await handleBotEvent(ctx.db, msg.p2p('fs_zhang', '/help'), { send, secret: BOT_SECRET })
    const help = JSON.stringify(sent[sent.length - 1])
    expect(help).toContain('/my')
    expect(help).toContain('/week')
    expect(help).toContain('/risk')
    // web 入口：AI 助手会话发 /my（同一注册表）
    const cookie = await loginCookie(ctx.app, 'lisi', 'pass-123456')
    const sess = await authed(ctx.app, cookie, 'POST', '/api/v1/chat/sessions', {})
    const r = await authed(ctx.app, cookie, 'POST', `/api/v1/chat/sessions/${sess.body.id}/messages`, { text: '/my' })
    expect(r.status).toBe(200)
    expect(r.body.assistant.content).toContain('未完任务 2 项')
  })
})
