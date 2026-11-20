import { describe, it, expect, afterAll } from 'vitest'
import { setupDb, seedMembers } from './helpers.mjs'
import { createProject } from '../engine/projects.js'
import { createTask, upsertChannel } from '../engine/tasks.js'
import { bufferInboundMessage, runExtraction } from '../brain/extract.js'
import { evaluateReminders } from '../brain/reminder.js'
import { today, bjDayStartMs } from '../db/time.js'

// PRD S60（v0.65 建，K44；v0.96.1 K44 修订）— 抽取后群进展播报：
// extraction 周期尾部把本轮各项目沉淀的进展事件按项目聚合（缓冲排干与 API 游标两路汇聚），
// 该项目本轮存在至少一条任务状态变化（day_status 打卡自动生效 / status 字段建议自动生效）
// 才发一张绿色「🎉 有新进展」汇总卡，状态变化行 ✅ 显著标注；无状态变化周期完全静默。

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

/** mock 连接器：往 extract.js 注入一批新群消息（走 API 游标路径）。 */
function mockConnector(messages) {
  return {
    fetchMessages: async () => ({ messages, nextCursor: 'c1' }),
    sendText: async () => {}, sendPost: async () => {}, sendCard: async () => {},
  }
}

const chId = (groupKey) => db.prepare('SELECT id FROM channels WHERE group_key = ?').get(groupKey).id
const digestCount = (projectId) =>
  db.prepare(`SELECT COUNT(*) AS n FROM pushes WHERE push_type = 'progress_digest' AND related_project_id = ?`).get(projectId).n
// day_status 打卡候选（真实模型实测形态：targetName 带清单标记回显、targetTaskId 带 # 前缀）
const dayStatusEvent = (taskId, name, msgIndex = 0) => ({
  nature: 'record', eventType: 'progress', summary: `${name}打卡完成`,
  targetObject: 'task', targetTaskId: `#${taskId}`, targetName: `〔常态〕${name}`,
  targetField: 'day_status', targetValue: 'done', confidence: 0.92, msgIndex,
})

describe('S60 抽取后群进展播报（v0.96.1：状态变化闸门 + 两路汇聚）', () => {
  it('S60-1: 缓冲排干路径的打卡自动生效 → 专题群播报汇总卡，状态变化行 ✅ 标注（v0.96.1 修复：此前该路径永不播报）', async () => {
    ;({ db } = setupDb())
    members = seedMembers(db)
    const p = createProject(db, {
      name: '常态打卡群', kind: 'routine', typeCode: 'routine_ops', leadMemberId: members.lead.id, tasks: ['看资讯'],
    }, members.admin.id)
    upsertChannel(db, { platform: 'feishu', groupKey: 'oc_routine', channelType: 'dedicated', projectId: p.id })
    // 群里发打卡消息（未@机器人 → 网关落 im_buffer，抽取经缓冲排干摄入）
    bufferInboundMessage(db, { platform: 'feishu', groupKey: 'oc_routine', messageId: 'om_ck1', speakerId: 'fs_zhang', text: '看资讯打卡', ts: atHour(10)() })
    const sent = []
    await runExtraction(db, { channelId: chId('oc_routine') }, {
      llm: fakeLlm([dayStatusEvent(p.tasks[0].id, '看资讯')]),
      send: fakeSend(sent),
      connectors: { feishu: mockConnector([]) }, // API 游标路径零新消息——进展只能来自缓冲排干
    })
    // 打卡已落库（自动生效），播报已发出
    expect(db.prepare('SELECT * FROM task_day_records WHERE task_id = ? AND day = ?').get(p.tasks[0].id, today())).toBeTruthy()
    const rows = db.prepare(`SELECT * FROM pushes WHERE push_type = 'progress_digest' AND related_project_id = ?`).all(p.id)
    expect(rows.length).toBe(1)
    expect(rows[0].group_key).toBe('oc_routine')
    expect(rows[0].status).toBe('sent')
    expect(rows[0].title).toContain('🎉')
    expect(rows[0].title).toContain('常态打卡群')
    // 群卡片：绿色 header，状态变化行 ✅ 显著标注
    const grp = sent.find((s) => s.chatId === 'oc_routine')
    expect(grp).toBeTruthy()
    expect(grp.card).toBeTruthy()
    expect(grp.card.header.template).toBe('green')
    const cardJson = JSON.stringify(grp.card)
    expect(cardJson).toContain('✅')
    expect(cardJson).toContain('完成')
  })

  it('S60-2: 无任务状态变化即静默——仅有普通进展/只有风险/无新消息/全噪音，都不发不落行', async () => {
    const p = seedProjectWithChannel('纯进展项目', 'oc_plain')
    const before = digestCount(p.id)
    // ① 仅普通 record 进展（无状态变化）——v0.96.1 新闸门：不播报
    const sent1 = []
    await runExtraction(db, { channelId: chId('oc_plain') }, {
      llm: fakeLlm([{ nature: 'record', eventType: 'progress', summary: '接口联调已完成', confidence: 0.9 }]),
      send: fakeSend(sent1),
      connectors: { feishu: mockConnector([{ id: 'm1', speakerId: 'fs_li', speakerName: '李四', text: '接口联调这块搞完了', ts: Date.now() }]) },
    })
    expect(sent1.length).toBe(0)
    // ② 只有风险
    const sent2 = []
    await runExtraction(db, { channelId: chId('oc_plain') }, {
      llm: fakeLlm([{ nature: 'record', eventType: 'risk', summary: '进度可能滞后', confidence: 0.8 }]),
      send: fakeSend(sent2),
      connectors: { feishu: mockConnector([{ id: 'm2', speakerId: 'fs_li', speakerName: '李四', text: '这块进度有点悬', ts: Date.now() }]) },
    })
    expect(sent2.length).toBe(0)
    // ③ 无新群消息
    const sent3 = []
    await runExtraction(db, { channelId: chId('oc_plain') }, { llm: fakeLlm([]), send: fakeSend(sent3), connectors: { feishu: mockConnector([]) } })
    expect(sent3.length).toBe(0)
    // ④ 全噪音（S50 过滤）
    const sent4 = []
    await runExtraction(db, { channelId: chId('oc_plain') }, {
      llm: fakeLlm([]), send: fakeSend(sent4),
      connectors: { feishu: mockConnector([{ id: 'm3', speakerId: 'fs_li', speakerName: '李四', text: '👍', ts: Date.now() }]) },
    })
    expect(sent4.length).toBe(0)
    expect(digestCount(p.id)).toBe(before)
  })

  it('S60-3: 任务状态建议自动生效触发播报；卡片发送失败降级富文本（含 ✅）；同周期不重复播报（幂等）', async () => {
    // 独立项目（oc_routine 已在同周期播报过，复用会被幂等闸挡）
    const p = seedProjectWithChannel('降级验证项目', 'oc_degrade')
    const task = createTask(db, { projectId: p.id, title: '原型评审', responsibleMemberId: members.dev.id }, members.admin.id)
    // 卡片发送器抛错 → 降级文本
    const sent = []
    const flakySend = async (payload) => {
      if (payload.card) throw new Error('card send failed')
      sent.push(payload); return { messageId: 'om_fb' }
    }
    await runExtraction(db, { channelId: chId('oc_degrade') }, {
      llm: fakeLlm([{ nature: 'suggestion', eventType: 'status_change', summary: '原型评审已完成', targetObject: 'task', targetTaskId: task.id, targetName: '原型评审', targetField: 'status', targetValue: 'done', confidence: 0.92, msgIndex: 0 }]),
      send: flakySend,
      connectors: { feishu: mockConnector([{ id: 'm4', speakerId: 'fs_li', speakerName: '李四', text: '原型评审过了', ts: Date.now() }]) },
    })
    // 任务状态确实自动生效（K50 白名单通道）
    expect(db.prepare('SELECT status FROM tasks WHERE id = ?').get(task.id).status).toBe('done')
    // 降级后群收到的是文本（无 card），且 ✅ 标注保留
    const grp = sent.find((s) => s.chatId === 'oc_degrade')
    expect(grp).toBeTruthy()
    expect(grp.card).toBeUndefined()
    const fallback = grp.text || JSON.stringify(grp.post || {})
    expect(fallback).toBeTruthy()
    expect(fallback).toContain('✅')
    // 同周期再跑（本轮锚点内已有播报）不重复发
    const before = digestCount(p.id)
    const sent2 = []
    await runExtraction(db, { channelId: chId('oc_degrade') }, {
      llm: fakeLlm([{ nature: 'suggestion', eventType: 'status_change', summary: '又一项完成', targetObject: 'task', targetTaskId: task.id, targetName: '原型评审', targetField: 'status', targetValue: 'done', confidence: 0.92, msgIndex: 0 }]),
      send: fakeSend(sent2),
      connectors: { feishu: mockConnector([{ id: 'm5', speakerId: 'fs_li', speakerName: '李四', text: '又搞定一件事', ts: Date.now() }]) },
    })
    expect(digestCount(p.id)).toBe(before)
  })

  it('S60-4: 提醒任务到期自动完成产生的「系统提醒已送达」不触发进展播报', async () => {
    // 新项目：只跑提醒自动完成，不跑抽取——pushes 里不应出现 progress_digest
    seedProjectWithChannel('纯提醒项目', 'oc_pure')
    const p2 = db.prepare('SELECT id FROM projects WHERE name = ?').get('纯提醒项目')
    createTask(db, { projectId: p2.id, title: '到期提醒', kind: 'reminder', responsibleMemberId: members.dev.id, planEndDate: today() }, members.admin.id)
    const sent = []
    await evaluateReminders(db, { send: fakeSend(sent), now: atHour(10) })
    // 提醒推送发了（reminder 类型），但没有 progress_digest
    expect(digestCount(p2.id)).toBe(0)
  })

  it('S60-5: 混合轮只发一卡——状态变化行 ✅、普通进展行不标；缓冲排干与 API 游标两路事件同卡聚合', async () => {
    const p = createProject(db, {
      name: '混合轮项目', kind: 'routine', typeCode: 'routine_ops', leadMemberId: members.lead.id, tasks: ['晨间巡检'],
    }, members.admin.id)
    upsertChannel(db, { platform: 'feishu', groupKey: 'oc_mixed', channelType: 'dedicated', projectId: p.id })
    // 缓冲路径：两条文字消息（打卡 + 普通进展）
    bufferInboundMessage(db, { platform: 'feishu', groupKey: 'oc_mixed', messageId: 'om_mx1', speakerId: 'fs_zhang', text: '晨间巡检打卡', ts: atHour(9)() })
    bufferInboundMessage(db, { platform: 'feishu', groupKey: 'oc_mixed', messageId: 'om_mx2', speakerId: 'fs_zhang', text: '下午茶物料也确认好了', ts: atHour(9)() + 60_000 })
    const sent = []
    await runExtraction(db, { channelId: chId('oc_mixed') }, {
      llm: fakeLlm([
        dayStatusEvent(p.tasks[0].id, '晨间巡检', 0),
        { nature: 'record', eventType: 'progress', summary: '下午茶物料确认完成', confidence: 0.9, msgIndex: 1 },
        // API 路径消息（如文件分享等不入缓冲的形态）产出的普通进展
        { nature: 'record', eventType: 'progress', summary: '逐字稿已上传团队群', confidence: 0.88, msgIndex: 2 },
      ]),
      send: fakeSend(sent),
      // API 游标路径：一条不入缓冲的补充消息，与缓冲事件同轮汇入同项目
      connectors: { feishu: mockConnector([{ id: 'om_mx3', speakerId: 'fs_zhang', speakerName: '张三', text: '逐字稿发群里了', ts: atHour(9)() + 120_000 }]) },
    })
    // 一张卡：三条进展都在，仅状态变化行带 ✅
    const grp = sent.find((s) => s.chatId === 'oc_mixed')
    expect(grp).toBeTruthy()
    expect(grp.card).toBeTruthy()
    const cardJson = JSON.stringify(grp.card)
    expect(cardJson).toContain('晨间巡检')
    expect(cardJson).toContain('下午茶物料确认完成')
    expect(cardJson).toContain('逐字稿已上传团队群')
    expect((cardJson.match(/✅/g) || []).length).toBe(1)
    expect(digestCount(p.id)).toBe(1)
  })
})
