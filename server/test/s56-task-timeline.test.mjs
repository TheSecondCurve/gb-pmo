import { describe, it, expect, afterAll } from 'vitest'
import { setupDb, seedMembers } from './helpers.mjs'
import { createProject } from '../engine/projects.js'
import { upsertChannel } from '../engine/tasks.js'
import { ingestMessages } from '../brain/extract.js'
import { listTaskRecords } from '../engine/tasks.js'

// PRD S56（v0.61，K39）— 聊天进展自动归档任务时间线：
// 记录型事件带合法 targetTaskId 时同步追加 task_records（addTaskRecord 既有守卫与审计）

let db
let members
afterAll(() => db?.close())

const fakeLlm = (events) => ({ name: 'fake', complete: async () => JSON.stringify({ events }) })

describe('S56 聊天进展归档任务时间线', () => {
  it('S56-1: 记录型事件带合法 targetTaskId → 同步追加任务更新记录（内容=摘要、记录人=发言人）', async () => {
    ;({ db } = setupDb())
    members = seedMembers(db)
    const p = createProject(db, { name: '归档项目', typeCode: 'lianmai_365', leadMemberId: members.lead.id }, members.admin.id)
    const ch = upsertChannel(db, { platform: 'feishu', groupKey: 'oc_arc', channelType: 'dedicated', projectId: p.id })
    const t = p.tasks[0]
    const stats = await ingestMessages(db, ch, [
      { id: 'ar1', speakerId: 'fs_li', text: '连麦记录创建好了，主负责人已定', ts: Date.now() },
    ], {
      llm: fakeLlm([{ nature: 'record', eventType: 'progress', summary: '连麦记录已创建并定主负责人', targetTaskId: t.id, confidence: 0.9 }]),
    })
    expect(stats.events).toBe(1)
    expect(stats.taskRecords).toBe(1)
    const records = listTaskRecords(db, t.id)
    expect(records.length).toBe(1)
    expect(records[0].content).toBe('连麦记录已创建并定主负责人')
    expect(records[0].memberId).toBe(members.dev.id) // 发言人映射（李四）
    // 事件本身照常落库且带任务归属
    const evt = db.prepare('SELECT * FROM project_events WHERE project_id = ? AND target_task_id = ?').get(p.id, t.id)
    expect(evt).toBeTruthy()
    expect(evt.nature).toBe('record')
  })

  it('S56-2: 不带/非法 targetTaskId → 事件照落但不产任务记录', async () => {
    const p = db.prepare('SELECT id, name FROM projects WHERE name = ?').get('归档项目')
    const ch = { platform: 'feishu', groupKey: 'oc_arc', channelType: 'dedicated', projectId: p.id }
    const before = db.prepare('SELECT COUNT(*) AS n FROM task_records').get().n
    const stats = await ingestMessages(db, ch, [
      { id: 'ar2', speakerId: 'fs_zhang', text: '项目整体节奏良好', ts: Date.now() },
      { id: 'ar3', speakerId: 'fs_zhang', text: '随便说说的任务归属', ts: Date.now() },
    ], {
      llm: fakeLlm([
        { nature: 'record', eventType: 'progress', summary: '整体节奏良好' }, // 无 targetTaskId
        { nature: 'record', eventType: 'progress', summary: '非法归属', targetTaskId: 99999 }, // 非法 id
      ]),
    })
    expect(stats.events).toBe(2)
    expect(db.prepare('SELECT COUNT(*) AS n FROM task_records').get().n).toBe(before) // 不产记录
    const evt = db.prepare('SELECT * FROM project_events WHERE summary = ?').get('非法归属')
    expect(evt).toBeTruthy()
    expect(evt.target_task_id).toBeNull() // 字段丢弃不丢事件
  })

  it('S56-3: 任务已删除 → 记录静默跳过，事件与后续消息不阻塞', async () => {
    const p = db.prepare('SELECT id FROM projects WHERE name = ?').get('归档项目')
    const ch = { platform: 'feishu', groupKey: 'oc_arc', channelType: 'dedicated', projectId: p.id }
    const t = db.prepare('SELECT id FROM tasks WHERE project_id = ? ORDER BY id LIMIT 1').get(p.id)
    db.prepare('UPDATE tasks SET deleted_at = ? WHERE id = ?').run(Date.now(), t.id) // S36 软删
    // 注意：已删任务同时退出抽取白名单（validTasks 不含），LLM 即使给了 id 也被丢弃
    const stats = await ingestMessages(db, ch, [
      { id: 'ar4', speakerId: 'fs_zhang', text: '这条任务的历史补充', ts: Date.now() },
      { id: 'ar5', speakerId: 'fs_zhang', text: '另一条正常消息', ts: Date.now() },
    ], {
      llm: fakeLlm([
        { nature: 'record', eventType: 'progress', summary: '已删任务补充', targetTaskId: t.id },
        { nature: 'record', eventType: 'progress', summary: '正常进展' },
      ]),
    })
    expect(stats.events).toBe(2) // 事件都落了
    expect(listTaskRecords(db, t.id).length).toBe(1) // 只有 S56-1 那一条，未新增
  })

  it('S56-4: LLM 未配置（降级路径）不产任务记录，事件落库不变', async () => {
    const p = db.prepare('SELECT id FROM projects WHERE name = ?').get('归档项目')
    const ch = { platform: 'feishu', groupKey: 'oc_arc', channelType: 'dedicated', projectId: p.id }
    const before = db.prepare('SELECT COUNT(*) AS n FROM task_records').get().n
    const stats = await ingestMessages(db, ch, [
      { id: 'ar6', speakerId: 'fs_li', text: '降级路径的实质进展消息', ts: Date.now() },
    ], {}) // 无 LLM
    expect(stats.events).toBe(1)
    expect(stats.taskRecords ?? 0).toBe(0)
    expect(db.prepare('SELECT COUNT(*) AS n FROM task_records').get().n).toBe(before)
  })
})
