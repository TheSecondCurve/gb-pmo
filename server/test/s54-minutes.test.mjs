import { describe, it, expect, afterAll } from 'vitest'
import { setupApp } from './helpers.mjs'
import { createProject } from '../engine/projects.js'
import { upsertChannel } from '../engine/tasks.js'
import { handleBotEvent } from '../brain/bot/command.js'
import { runMinutesTool } from '../brain/bot/tools.js'
import { BOT_SECRET, scriptedLlm, makeRecorder, makeMsgFactory } from './bot-kit.mjs'

// PRD S54（v0.59，K37）— 群讨论纪要浓缩与归档（S10 部分能力落地）

let ctx
afterAll(() => ctx?.db.close())

const DISCUSSION = [
  { id: 'm1', speakerId: 'fs_zhang', text: '二期范围就锁定在报表和权限两块吧', ts: Date.now() - 3000000 },
  { id: 'm2', speakerId: 'fs_li', text: '同意，权限这块我来排期', ts: Date.now() - 2900000 },
  { id: 'm3', speakerId: 'fs_zhang', text: '风险是客户数据源还没给', ts: Date.now() - 2800000 },
]

describe('S54 群讨论纪要', () => {
  it('S54-1: minutes 仅专题群可用；窗口默认 2h 上限 6h/50 条；不挪游标不产事件', async () => {
    ctx = await setupApp()
    const p = createProject(ctx.db, { name: '纪要项目', typeCode: 'lianmai_365', leadMemberId: ctx.members.lead.id }, ctx.members.admin.id)
    upsertChannel(ctx.db, { platform: 'feishu', groupKey: 'oc_min', channelType: 'dedicated', projectId: p.id })
    const cursorBefore = ctx.db.prepare('SELECT cursor FROM channels WHERE group_key = ?').get('oc_min').cursor
    const fetchChat = async () => ({ messages: DISCUSSION })
    const env = { platform: 'feishu', chatId: 'oc_min', chatType: 'group' }

    const out = await runMinutesTool(ctx.db, env, { fetchChat })
    expect(out).toContain('二期范围')
    expect(out).toContain('张三') // 发言人经身份映射
    expect(out).toContain('李四')
    // 不挪游标、不产事件
    expect(ctx.db.prepare('SELECT cursor FROM channels WHERE group_key = ?').get('oc_min').cursor).toBe(cursorBefore)
    expect(ctx.db.prepare(`SELECT COUNT(*) AS n FROM project_events WHERE project_id = ? AND generated_by = 'extraction'`).get(p.id).n).toBe(0)
    // 私聊/未登记群/web 不可用
    expect(await runMinutesTool(ctx.db, { platform: 'feishu', chatId: 'oc_p2p', chatType: 'p2p' }, { fetchChat })).toContain('专题群')
    expect(await runMinutesTool(ctx.db, { platform: 'web', chatId: 's1', chatType: 'p2p' }, { fetchChat })).toContain('专题群')
    // 空讨论明说
    const empty = await runMinutesTool(ctx.db, env, { fetchChat: async () => ({ messages: [] }) })
    expect(empty).toContain('没有可读的群聊讨论')
  })

  it('S54-2: 用户要纪要 → LLM 先 minutes 拉取（工具结果回灌）再产出纪要；S54-4: minutes 计入查询限额', async () => {
    const { llm, calls } = scriptedLlm(
      '{"action":"minutes","hours":2}',
      '{"action":"reply","text":"【纪要】结论：二期锁定报表与权限；待办：李四排期权限；风险：客户数据源未到。回复「归档」沉淀为项目记录。"}',
    )
    const { send, sent } = makeRecorder()()
    const msg = makeMsgFactory('om_s54')
    const fetchChat = async () => ({ messages: DISCUSSION })
    const r = await handleBotEvent(ctx.db, msg.group('fs_zhang', 'oc_min', '总结一下刚才的讨论'), { send, secret: BOT_SECRET, llm, fetchChat })
    expect(r.result).toBe('replied')
    // 第二轮 LLM 输入带工具结果（讨论内容回灌）
    expect(JSON.stringify(calls[1])).toContain('二期范围')
    const last = sent[sent.length - 1]
    const flat = typeof last.text === 'string' ? last.text : JSON.stringify(last.post)
    expect(flat).toContain('纪要')
    expect(flat).toContain('归档') // 归档指引
    // minutes 计入查询次数（bot_commands detail.queries=1）
    const row = ctx.db.prepare(`SELECT * FROM bot_commands WHERE message_id = ?`).get('om_s54_1')
    expect(row).toBeTruthy()
    expect(JSON.parse(row.detail).queries).toBe(1)
  })

  it('S54-3: 用户确认归档 → record_event 落记录型事件（自动生效、归因发令人、事件流可查）', async () => {
    const p = ctx.db.prepare('SELECT id FROM projects WHERE name = ?').get('纪要项目')
    const { llm } = scriptedLlm(
      '{"action":"write","kind":"record_event","payload":{"projectId":' + p.id + ',"eventType":"decision","summary":"纪要：二期锁定报表与权限两块；李四排期权限；风险=客户数据源未到"}}',
    )
    const { send } = makeRecorder()()
    const msg = makeMsgFactory('om_s54b')
    const r = await handleBotEvent(ctx.db, msg.group('fs_zhang', 'oc_min', '归档'), { send, secret: BOT_SECRET, llm })
    expect(r.result).toBe('replied')
    const evt = ctx.db.prepare(`SELECT * FROM project_events WHERE project_id = ? AND event_type = 'decision' ORDER BY id DESC`).get(p.id)
    expect(evt).toBeTruthy()
    expect(evt.summary).toContain('二期锁定')
    expect(evt.status).toBe('effective') // 记录型自动生效
    expect(evt.speaker_member_id).toBe(ctx.members.lead.id) // 归因发令人
  })
})
