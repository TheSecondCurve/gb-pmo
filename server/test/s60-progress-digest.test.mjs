import { describe, it, expect, afterAll } from 'vitest'
import { setupDb, seedMembers } from './helpers.mjs'
import { createProject } from '../engine/projects.js'
import { createTask, upsertChannel } from '../engine/tasks.js'
import { evaluateReminders } from '../brain/reminder.js'
import { runExtraction } from '../brain/extract.js'
import { today, bjDayStartMs } from '../db/time.js'

// PRD S60（v0.65，K44）— 抽取后群进展播报：
// extraction 周期尾部把本轮各项目沉淀的 record 型 progress 事件按项目聚合，
// 往项目绑定的飞书专题群（dedicated）发一张绿色「🎉 有新进展」汇总卡。
// 三道闸任一不过即静默：无新消息 / 全是噪音 / 无进展事件，都不发、不打扰团队。

let db
let members
afterAll(() => db?.close())

const fakeLlm = (events) => ({ name: 'fake', complete: async () => JSON.stringify({ events }) })
function fakeSend(sink) {
  return async (payload) => { sink.push(payload); return { messageId: `om_${sink.length}` } }
}
const atHour = (h) => () => bjDayStartMs(Date.now()) + h * 3_600_000

function seedProjectWithChannel(name, groupKey) {
  const p = createProject(db, { name, typeCode: 'lianmai_365', leadMemberId: members.lead.id }, members.admin.id)
  upsertChannel(db, { platform: 'feishu', groupKey, name: `${name}群`, channelType: 'dedicated', projectId: p.id })
  return p
}

/** mock 连接器：往 extract.js 注入一批新群消息。 */
function mockConnector(messages) {
  return {
    fetchMessages: async () => ({ messages, nextCursor: 'c1' }),
    sendText: async () => {}, sendPost: async () => {}, sendCard: async () => {},
  }
}

describe('S60 抽取后群进展播报', () => {
  it('S60-1: 本轮沉淀了 record 型 progress 事件 → 往专题群发绿色汇总卡（🎉+项目名+进展列表）', async () => {
    ;({ db } = setupDb())
    members = seedMembers(db)
    const p = seedProjectWithChannel('智慧园区', 'oc_park')
    // 注入一条新群消息，LLM 抽出一条 record 型 progress
    db.prepare('UPDATE channels SET platform = ? WHERE group_key = ?').run('feishu', 'oc_park')
    const sent = []
    // 用 connector mock 让 fetchMessages 返回新消息；send 用 fakeSend 捕获推送
    await runExtraction(db, { channelId: db.prepare('SELECT id FROM channels WHERE group_key = ?').get('oc_park').id }, {
      llm: fakeLlm([{ nature: 'record', eventType: 'progress', summary: '接口联调已完成', confidence: 0.9 }]),
      send: fakeSend(sent),
      connectors: { feishu: mockConnector([{ id: 'm1', speakerId: 'fs_li', speakerName: '李四', text: '接口联调这块搞完了', ts: Date.now() }]) },
    })
    // 群推送落痕
    const rows = db.prepare(`SELECT * FROM pushes WHERE push_type = 'progress_digest' AND related_project_id = ?`).all(p.id)
    expect(rows.length).toBe(1)
    expect(rows[0].group_key).toBe('oc_park')
    expect(rows[0].status).toBe('sent')
    expect(rows[0].title).toContain('🎉')
    expect(rows[0].title).toContain('智慧园区')
    // 发送器收到群卡片（chatId=专题群，带 card）
    const grp = sent.find((s) => s.chatId === 'oc_park')
    expect(grp).toBeTruthy()
    expect(grp.card).toBeTruthy()
    expect(grp.card.header.template).toBe('green')
  })

  it('S60-2: 三道闸任一不过即静默——无新消息/全是噪音/无进展事件，都不发群消息', async () => {
    const chId = db.prepare('SELECT id FROM channels WHERE group_key = ?').get('oc_park').id
    const before = db.prepare(`SELECT COUNT(*) AS n FROM pushes WHERE push_type = 'progress_digest'`).get().n
    // 闸 1：本轮无新群消息
    const sent1 = []
    await runExtraction(db, { channelId: chId }, { llm: fakeLlm([]), send: fakeSend(sent1), connectors: { feishu: mockConnector([]) } })
    expect(sent1.length).toBe(0)
    // 闸 2：拉到消息但全是噪音（S50 过滤）
    const sent2 = []
    await runExtraction(db, { channelId: chId }, { llm: fakeLlm([]), send: fakeSend(sent2), connectors: { feishu: mockConnector([{ id: 'm2', speakerId: 'fs_li', speakerName: '李四', text: '👍', ts: Date.now() }]) } })
    expect(sent2.length).toBe(0)
    // 闸 3：抽取出事件但无一条 progress（只有风险）
    const sent3 = []
    await runExtraction(db, { channelId: chId }, { llm: fakeLlm([{ nature: 'record', eventType: 'risk', summary: '进度可能滞后', confidence: 0.8 }]), send: fakeSend(sent3), connectors: { feishu: mockConnector([{ id: 'm3', speakerId: 'fs_li', speakerName: '李四', text: '这块进度有点悬', ts: Date.now() }]) } })
    expect(sent3.length).toBe(0)
    expect(db.prepare(`SELECT COUNT(*) AS n FROM pushes WHERE push_type = 'progress_digest'`).get().n).toBe(before)
  })

  it('S60-3: 卡片发送失败降级富文本补发；同周期不重复播报（幂等）', async () => {
    // 独立项目（S60-1 已在同周期给 oc_park 播报过，复用会被幂等闸挡）
    const p = seedProjectWithChannel('降级验证项目', 'oc_degrade')
    const chId = db.prepare('SELECT id FROM channels WHERE group_key = ?').get('oc_degrade').id
    // 卡片发送器抛错 → 降级文本
    const sent = []
    const flakySend = async (payload) => {
      if (payload.card) throw new Error('card send failed')
      sent.push(payload); return { messageId: 'om_fb' }
    }
    await runExtraction(db, { channelId: chId }, {
      llm: fakeLlm([{ nature: 'record', eventType: 'progress', summary: '原型评审通过', confidence: 0.9 }]),
      send: flakySend,
      connectors: { feishu: mockConnector([{ id: 'm4', speakerId: 'fs_li', speakerName: '李四', text: '原型评审过了', ts: Date.now() }]) },
    })
    // 降级后群收到的是文本（无 card）
    const grp = sent.find((s) => s.chatId === 'oc_degrade')
    expect(grp).toBeTruthy()
    expect(grp.card).toBeUndefined()
    expect(grp.text || grp.post).toBeTruthy()
    // 同周期再跑（本轮锚点内已有播报）不重复发
    const before = db.prepare(`SELECT COUNT(*) AS n FROM pushes WHERE push_type = 'progress_digest' AND related_project_id = ?`).get(p.id).n
    const sent2 = []
    await runExtraction(db, { channelId: chId }, {
      llm: fakeLlm([{ nature: 'record', eventType: 'progress', summary: '又一条进展', confidence: 0.9 }]),
      send: fakeSend(sent2),
      connectors: { feishu: mockConnector([{ id: 'm5', speakerId: 'fs_li', speakerName: '李四', text: '又搞定一件事', ts: Date.now() }]) },
    })
    expect(db.prepare(`SELECT COUNT(*) AS n FROM pushes WHERE push_type = 'progress_digest' AND related_project_id = ?`).get(p.id).n).toBe(before)
  })

  it('S60-4: 提醒任务到期自动完成产生的「系统提醒已送达」不触发进展播报', async () => {
    // 新项目：只跑提醒自动完成，不跑抽取——pushes 里不应出现 progress_digest
    seedProjectWithChannel('纯提醒项目', 'oc_pure')
    const p2 = db.prepare('SELECT id FROM projects WHERE name = ?').get('纯提醒项目')
    createTask(db, { projectId: p2.id, title: '到期提醒', kind: 'reminder', responsibleMemberId: members.dev.id, planEndDate: today() }, members.admin.id)
    const sent = []
    await evaluateReminders(db, { send: fakeSend(sent), now: atHour(10) })
    // 提醒推送发了（reminder 类型），但没有 progress_digest
    const digestRows = db.prepare(`SELECT COUNT(*) AS n FROM pushes WHERE push_type = 'progress_digest' AND related_project_id = ?`).get(p2.id).n
    expect(digestRows).toBe(0)
  })
})
