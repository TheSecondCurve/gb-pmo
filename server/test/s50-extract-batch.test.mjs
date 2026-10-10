import { describe, it, expect, afterAll } from 'vitest'
import { setupDb, seedMembers } from './helpers.mjs'
import { createProject } from '../engine/projects.js'
import { upsertChannel } from '../engine/tasks.js'
import { ingestMessages, isNoiseMessage } from '../brain/extract.js'

// PRD S50（v0.55，K33）— 抽取噪音预过滤 + 按项目批量抽取：
// 噪音不进 LLM；按项目归组分批（≤8 条且 ≤3000 字）一次调用；事件按 msgIndex 归因源消息。

let db
afterAll(() => db?.close())

const fakeLlm = (handler) => ({ name: 'fake', complete: async (messages, opts) => handler(messages, opts) })

describe('S50 噪音预过滤与批量抽取', () => {
  it('S50-1: 空/纯表情/应酬白名单/单字符消息直接跳过（noiseSkipped），实质短消息保留', async () => {
    ;({ db } = setupDb())
    const members = seedMembers(db)
    expect(isNoiseMessage('收到')).toBe(true)
    expect(isNoiseMessage('👍')).toBe(true)
    expect(isNoiseMessage('👍👍')).toBe(true)
    expect(isNoiseMessage('OK')).toBe(true)
    expect(isNoiseMessage('嗯')).toBe(true)
    expect(isNoiseMessage('？？？')).toBe(true)
    expect(isNoiseMessage('完成了')).toBe(false) // 实质完成信号绝不可误杀
    expect(isNoiseMessage('推迟到下周')).toBe(false)
    expect(isNoiseMessage('这个方案客户不认可')).toBe(false)

    const p = createProject(db, { name: '噪音项目', typeCode: 'lianmai_365', leadMemberId: members.lead.id }, members.admin.id)
    const ch = upsertChannel(db, { platform: 'feishu', groupKey: 'oc_noise', channelType: 'dedicated', projectId: p.id })
    let calls = 0
    const llm = fakeLlm(() => { calls++; return JSON.stringify({ events: [] }) })
    const stats = await ingestMessages(db, ch, [
      { id: 'n1', speakerId: 'fs_zhang', text: '收到', ts: Date.now() },
      { id: 'n2', speakerId: 'fs_zhang', text: '👍', ts: Date.now() },
      { id: 'n3', speakerId: 'fs_li', text: '接口联调完成了', ts: Date.now() },
    ], { llm })
    expect(stats.noiseSkipped).toBe(2)
    expect(calls).toBe(1) // 只有实质消息进 LLM（且批量一次调用）
  })

  it('S50-2: 专题渠道多条消息分批一次调用；msgIndex 归因源消息（缺省归末条）', async () => {
    ;({ db } = setupDb())
    const members = seedMembers(db)
    const p = createProject(db, { name: '批量项目', typeCode: 'lianmai_365', leadMemberId: members.lead.id }, members.admin.id)
    const ch = upsertChannel(db, { platform: 'feishu', groupKey: 'oc_batch', channelType: 'dedicated', projectId: p.id })
    const t0 = Date.now() - 3600000
    const llm = fakeLlm((messages) => {
      // 断言批内 3 条消息一次进来（prompt 用户段含全部 3 条）
      expect(messages[1].content).toContain('任务一完成')
      expect(messages[1].content).toContain('任务二有风险')
      expect(messages[1].content).toContain('明天联调')
      return JSON.stringify({
        events: [
          { msgIndex: 0, nature: 'record', eventType: 'progress', summary: '任务一完成', confidence: 0.9 },
          { msgIndex: 1, nature: 'record', eventType: 'risk', summary: '任务二有风险', confidence: 0.8 },
          { nature: 'record', eventType: 'progress', summary: '明天联调安排', confidence: 0.7 }, // 无 msgIndex → 归末条
        ],
      })
    })
    const stats = await ingestMessages(db, ch, [
      { id: 'b1', speakerId: 'fs_zhang', text: '任务一完成了', ts: t0 },
      { id: 'b2', speakerId: 'fs_li', text: '任务二有风险，客户环境没准备好', ts: t0 + 60000 },
      { id: 'b3', speakerId: 'fs_zhang', text: '明天联调', ts: t0 + 120000 },
    ], { llm })
    expect(stats.events).toBe(3)
    const rows = db.prepare('SELECT * FROM project_events WHERE project_id = ? ORDER BY id').all(p.id)
    const e1 = rows.find((r) => r.summary === '任务一完成')
    expect(e1.source_ref).toBe('b1')
    expect(e1.business_time).toBe(t0)
    expect(e1.speaker_label).toBe('张三')
    const e2 = rows.find((r) => r.summary === '任务二有风险')
    expect(e2.source_ref).toBe('b2')
    expect(e2.speaker_label).toBe('李四')
    const e3 = rows.find((r) => r.summary === '明天联调安排')
    expect(e3.source_ref).toBe('b3') // 缺省归批次末条
    // 抽取只调用一次（llm_calls 记账佐证）
    expect(db.prepare(`SELECT COUNT(*) AS n FROM llm_calls WHERE purpose = 'extraction'`).get().n).toBe(1)
  })

  it('S50-3: 通用群按项目分组批量抽取；分拣维持逐条；对人建议按源消息发言人过滤', async () => {
    ;({ db } = setupDb())
    const members = seedMembers(db)
    const a = createProject(db, { name: '甲项目', typeCode: 'lianmai_365', leadMemberId: members.lead.id }, members.admin.id)
    const b = createProject(db, { name: '乙项目', typeCode: 'lianmai_365', leadMemberId: members.dev.id }, members.admin.id)
    const g = upsertChannel(db, { platform: 'feishu', groupKey: 'oc_gen', channelType: 'general' })
    let routingCalls = 0
    const extractCalls = []
    const llm = fakeLlm((messages) => {
      const sys = messages[0].content
      if (sys.includes('分拣器')) {
        routingCalls++
        const msgLine = messages[1].content.split('\n').pop() || '' // 清单也含项目名，只看消息行
        return JSON.stringify(msgLine.includes('甲项目') ? { projectId: a.id, confidence: 0.9 } : { projectId: b.id, confidence: 0.9 })
      }
      extractCalls.push(messages[1].content)
      return JSON.stringify({
        events: [
          { msgIndex: 0, nature: 'suggestion', eventType: 'owner_change', summary: '把任务交给小王', targetTaskId: a.tasks[0].id, targetField: 'responsible_member_id', targetValue: String(members.key.id) },
          { nature: 'record', eventType: 'progress', summary: '分组进展', confidence: 0.9 },
        ],
      })
    })
    const stats = await ingestMessages(db, g, [
      { id: 'g1', speakerId: 'fs_unknown', text: '甲项目的活交给小王', ts: Date.now() },
      { id: 'g2', speakerId: 'fs_zhang', text: '乙项目今天联调通过', ts: Date.now() },
    ], { llm })
    expect(routingCalls).toBe(2) // 分拣逐条不合并
    expect(extractCalls.length).toBe(2) // 按项目分组各一次
    expect(stats.events).toBe(2)
    // g1 发言人未识别 → 对人建议被过滤（S3-3 延伸）；记录型保留
    expect(stats.suggestions).toBe(0)
    const evA = db.prepare('SELECT * FROM project_events WHERE project_id = ? AND raw_snapshot LIKE ?').all(a.id, '%甲项目%')
    expect(evA.length).toBe(1)
    expect(evA[0].event_type).toBe('progress') // owner_change 建议被过滤后只剩记录型
  })

  it('S50-4: 无 LLM 降级路径同样先过滤噪音，其余消息维持每条一条记录型进展事件', async () => {
    ;({ db } = setupDb())
    const members = seedMembers(db)
    const p = createProject(db, { name: '降级项目', typeCode: 'lianmai_365', leadMemberId: members.lead.id }, members.admin.id)
    const ch = upsertChannel(db, { platform: 'feishu', groupKey: 'oc_degrade', channelType: 'dedicated', projectId: p.id })
    const stats = await ingestMessages(db, ch, [
      { id: 'd1', speakerId: 'fs_zhang', text: '收到', ts: Date.now() },
      { id: 'd2', speakerId: 'fs_li', text: '方案已经发给客户了', ts: Date.now() },
    ], {}) // 无 LLM
    expect(stats.noiseSkipped).toBe(1)
    expect(stats.events).toBe(1) // 只有实质消息产降级记录
    const ev = db.prepare('SELECT * FROM project_events WHERE project_id = ? AND source_ref = ?').get(p.id, 'd2')
    expect(ev.event_type).toBe('progress')
  })
})
