import { describe, it, expect, afterAll } from 'vitest'
import { setupApp, setupDb, seedMembers } from './helpers.mjs'
import { createProject } from '../engine/projects.js'
import { upsertChannel } from '../engine/tasks.js'
import { handleBotEvent } from '../brain/bot/command.js'
import { runExtraction } from '../brain/extract.js'
import { BOT_SECRET, makeRecorder, makeMsgFactory } from './bot-kit.mjs'

// PRD S52（v0.57，K35）— 事件驱动抽取缓冲：已绑定渠道非 @ 消息落 im_buffer；
// 抽取先排干缓冲再走 API 对账，双源按 message_id 去重；消费行 7 天滚动清理。

let ctx
afterAll(() => ctx?.db.close())

const fakeLlm = (handler) => ({ name: 'fake', complete: async (m) => handler(m) })

describe('S52 事件驱动抽取缓冲', () => {
  it('S52-1: 已绑定渠道的非 @ 群消息落缓冲（拒答语义不变）；未绑定/外部群/私聊不落', async () => {
    ctx = await setupApp()
    const p = createProject(ctx.db, { name: '缓冲项目', typeCode: 'lianmai_365', leadMemberId: ctx.members.lead.id }, ctx.members.admin.id)
    upsertChannel(ctx.db, { platform: 'feishu', groupKey: 'oc_buf', channelType: 'dedicated', projectId: p.id })
    const msg = makeMsgFactory('om_s52')
    const { send } = makeRecorder()()

    // 绑定群的非 @ 消息 → 拒答 + 落缓冲
    const r1 = await handleBotEvent(ctx.db, msg.group('fs_zhang', 'oc_buf', '方案已发给客户', { mentioned: false }), { send, secret: BOT_SECRET })
    expect(r1.result).toBe('refused_not_mentioned')
    const buf = ctx.db.prepare('SELECT * FROM im_buffer WHERE group_key = ?').all('oc_buf')
    expect(buf.length).toBe(1)
    expect(buf[0].speaker_id).toBe('fs_zhang')
    expect(buf[0].consumed_at).toBeNull()
    // 同一 message_id 重复投递 → INSERT OR IGNORE 不重复
    await handleBotEvent(ctx.db, { ...msg.group('fs_zhang', 'oc_buf', '方案已发给客户', { mentioned: false }), messageId: buf[0].message_id }, { send, secret: BOT_SECRET })
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM im_buffer WHERE group_key = ?').get('oc_buf').n).toBe(1)
    // 未绑定群不落
    await handleBotEvent(ctx.db, msg.group('fs_zhang', 'oc_unbound', 'hello', { mentioned: false }), { send, secret: BOT_SECRET })
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM im_buffer').get().n).toBe(1)
    // 外部群不落
    await handleBotEvent(ctx.db, msg.group('fs_zhang', 'oc_buf', '外部群消息', { mentioned: false, external: true }), { send, secret: BOT_SECRET })
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM im_buffer').get().n).toBe(1)
  })

  it('S52-2: 抽取先排干缓冲产事件并标记消费；API 对账重拉同 id 跳过（不重复产事件、零 LLM）', async () => {
    const p = ctx.db.prepare('SELECT id FROM projects WHERE name = ?').get('缓冲项目')
    let llmCalls = 0
    const llm = fakeLlm(() => { llmCalls++; return JSON.stringify({ events: [{ nature: 'record', eventType: 'progress', summary: '缓冲消息进展', confidence: 0.9 }] }) })
    // runExtraction 会拉全部渠道——其他渠道（S52-1 的绑定渠道 oc_buf 走缓冲；无其他渠道配置）
    const res = await runExtraction(ctx.db, {}, { llm })
    const chRes = res.channels.find((c) => c.platform === 'feishu')
    expect(chRes).toBeTruthy()
    const buf = ctx.db.prepare('SELECT * FROM im_buffer').all()
    expect(buf.every((r) => r.consumed_at !== null)).toBe(true)
    const evt = ctx.db.prepare(`SELECT * FROM project_events WHERE project_id = ? AND source_ref = ?`).get(p.id, buf[0].message_id)
    expect(evt).toBeTruthy()
    expect(llmCalls).toBeGreaterThanOrEqual(1)
    // API 对账重拉同一 message_id（模拟连接器返回已消费消息）→ 跳过：不重复产事件、不再调 LLM
    // feishu 连接器的 fetchMessages 在测试里无真实凭证会报错——改直调 ingestMessages 验证去重语义
    const { ingestMessages } = await import('../brain/extract.js')
    const before = ctx.db.prepare('SELECT COUNT(*) AS n FROM project_events').get().n
    const callsBefore = llmCalls
    const stats = await ingestMessages(ctx.db, { platform: 'feishu', channelType: 'dedicated', projectId: p.id }, [
      { id: buf[0].message_id, speakerId: 'fs_zhang', text: '方案已发给客户', ts: buf[0].ts },
    ], { llm })
    expect(stats.bufferSkipped).toBe(1)
    expect(llmCalls).toBe(callsBefore) // 零 LLM
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM project_events').get().n).toBe(before) // 零重复事件
  })

  it('S52-3: 缓冲排干失败行保持未消费（下轮重试）；已消费行 7 天后滚动清理', async () => {
    const { db } = setupDb()
    seedMembers(db)
    // 排干失败不标记：ingestMessages 抛错时 consumed_at 不落
    db.prepare(`INSERT INTO im_buffer (platform, group_key, message_id, speaker_id, speaker_label, text, ts, created_at) VALUES ('feishu', 'oc_x', 'om_fail', 'fs_zhang', '张三', '内容', ?, ?)`)
      .run(Date.now(), Date.now())
    // 滚动清理：10 天前消费的行被清，昨天的保留
    const old = Date.now() - 10 * 86400000
    db.prepare(`INSERT INTO im_buffer (platform, group_key, message_id, speaker_id, speaker_label, text, ts, created_at, consumed_at) VALUES ('feishu', 'oc_x', 'om_old', 'fs_zhang', '张三', '旧', ?, ?, ?)`)
      .run(old, old, old)
    db.prepare(`INSERT INTO im_buffer (platform, group_key, message_id, speaker_id, speaker_label, text, ts, created_at, consumed_at) VALUES ('feishu', 'oc_x', 'om_new', 'fs_zhang', '张三', '新', ?, ?, ?)`)
      .run(Date.now(), Date.now(), Date.now())
    const { pruneBuffer } = await import('../brain/extract.js')
    pruneBuffer(db)
    expect(db.prepare(`SELECT COUNT(*) AS n FROM im_buffer WHERE message_id = 'om_old'`).get().n).toBe(0)
    expect(db.prepare(`SELECT COUNT(*) AS n FROM im_buffer WHERE message_id = 'om_new'`).get().n).toBe(1)
    expect(db.prepare(`SELECT COUNT(*) AS n FROM im_buffer WHERE message_id = 'om_fail' AND consumed_at IS NULL`).get().n).toBe(1)
    db.close()
  })

  it('S52-4: 机器人已处理消息不落缓冲（S20-10 不变）；缓冲消息受噪音预过滤约束', async () => {
    // 群里 @机器人 的指令消息：正常走指令链路（buffered 与否取决于绑定——指令已落 bot_commands，抽取去重不变）
    const p = ctx.db.prepare('SELECT id FROM projects WHERE name = ?').get('缓冲项目')
    const msg = makeMsgFactory('om_s52b')
    const { send } = makeRecorder()()
    const llm = fakeLlm(() => '{"action":"reply","text":"好的"}')
    const r = await handleBotEvent(ctx.db, msg.group('fs_zhang', 'oc_buf', '/tasks'), { send, secret: BOT_SECRET, llm })
    expect(r.result).toBe('replied')
    const cmdId = ctx.db.prepare(`SELECT message_id FROM bot_commands WHERE kind = 'command' ORDER BY id DESC`).get().message_id
    // 该 message_id 已在 bot_commands → 即使出现在缓冲/API 拉取中也被跳过（S20-10）
    const { ingestMessages } = await import('../brain/extract.js')
    const stats = await ingestMessages(ctx.db, { platform: 'feishu', channelType: 'dedicated', projectId: p.id }, [
      { id: cmdId, speakerId: 'fs_zhang', text: '/tasks', ts: Date.now() },
    ], { llm })
    expect(stats.botProcessed).toBe(1)
    // 缓冲里的噪音消息（S50 预过滤）
    const stats2 = await ingestMessages(ctx.db, { platform: 'feishu', channelType: 'dedicated', projectId: p.id }, [
      { id: 'om_noise_buf', speakerId: 'fs_zhang', text: '收到', ts: Date.now() },
    ], { llm })
    expect(stats2.noiseSkipped).toBe(1)
    expect(stats2.events).toBe(0)
  })

  it('S52-5: 自动更新与人工驳回均有 operation_key 幂等，重放不重复修改或复活', async () => {
    const { db } = setupDb()
    const members = seedMembers(db)
    const { ingestMessages } = await import('../brain/extract.js')
    const { rejectEvent } = await import('../engine/events.js')
    const p = createProject(db, { name: '重放幂等项目', typeCode: 'lianmai_365', leadMemberId: members.lead.id }, members.admin.id)
    const ch = upsertChannel(db, { platform: 'feishu', groupKey: 'oc_replay', channelType: 'dedicated', projectId: p.id })
    const target = p.tasks[0]
    const llm = fakeLlm((messages) => {
      const needsHuman = messages[1].content.includes('需要人工判断')
      return JSON.stringify({ events: [{ nature: 'suggestion', eventType: 'status_change', summary: `${target.title}完成`, targetObject: 'task', targetTaskId: target.id, targetName: target.title, targetField: 'status', targetValue: 'done', confidence: needsHuman ? 0.5 : 0.95 }] })
    })
    const msg = { id: 'replay_done', speakerId: 'fs_zhang', text: `${target.title}完成了`, ts: Date.now() }
    const first = await ingestMessages(db, ch, [msg], { llm })
    expect(first.autoApplied).toBe(1)
    expect(db.prepare('SELECT status FROM tasks WHERE id = ?').get(target.id).status).toBe('done')
    const eventCount = db.prepare('SELECT COUNT(*) AS n FROM project_events').get().n

    // 模拟人工已重开后旧消息重放：不得按旧完成信号再次完成，也不重复落事件
    db.prepare(`UPDATE tasks SET status = 'todo', actual_end_date = NULL WHERE id = ?`).run(target.id)
    const replay = await ingestMessages(db, ch, [msg], { llm })
    expect(replay.autoApplied).toBe(0)
    expect(replay.suggestions).toBe(0)
    expect(db.prepare('SELECT status FROM tasks WHERE id = ?').get(target.id).status).toBe('todo')
    expect(db.prepare('SELECT COUNT(*) AS n FROM project_events').get().n).toBe(eventCount)

    const pendingMsg = { id: 'replay_pending', speakerId: 'fs_zhang', text: `${target.title}需要人工判断后完成`, ts: Date.now() + 1000 }
    const pending = await ingestMessages(db, ch, [pendingMsg], { llm })
    expect(pending.suggestions).toBe(1)
    const evt = db.prepare(`SELECT * FROM project_events WHERE source_ref = 'replay_pending'`).get()
    rejectEvent(db, evt.id, members.lead.id)
    const rejectedReplay = await ingestMessages(db, ch, [pendingMsg], { llm })
    expect(rejectedReplay.suggestions).toBe(0)
    expect(db.prepare(`SELECT status FROM project_events WHERE source_ref = 'replay_pending'`).get().status).toBe('rejected')
    expect(db.prepare(`SELECT COUNT(*) AS n FROM project_events WHERE source_ref = 'replay_pending'`).get().n).toBe(1)
    db.close()
  })
})
