import { describe, it, expect, afterAll } from 'vitest'
import { setupDb, seedMembers } from './helpers.mjs'
import { createProject } from '../engine/projects.js'
import { createTask, updateTask } from '../engine/tasks.js'
import { addEvent, confirmEvent, listEvents } from '../engine/events.js'

// PRD S59（v0.65，K43）— 任务生命周期落进展：
// 新增（createTask）与完成（updateTask/applyTaskPatch 置 done）三路径各落一条
// record 型 progress 事件进讨论面进展列；add_task 建议确认与软删不重复落。

let db
let members
afterAll(() => db?.close())

/** 项目进展列里的 progress record 事件（按时间倒序，最新在前）。 */
function progressEvents(db, projectId) {
  return listEvents(db, { projectId, limit: 500 }).filter(
    (e) => e.eventType === 'progress' && e.nature === 'record',
  )
}

describe('S59 任务生命周期落进展', () => {
  it('S59-1: createTask 新增任务 → 同步落一条 record 型 progress 事件（🆕，generatedBy=web，即时生效）', () => {
    ;({ db } = setupDb())
    members = seedMembers(db)
    const p = createProject(db, { name: '进展项目', typeCode: 'lianmai_365', leadMemberId: members.lead.id }, members.admin.id)
    // 立项模板自带的任务也会各自落进展——先记下基线
    const baseline = progressEvents(db, p.id).length
    createTask(db, { projectId: p.id, title: '出体验报告', planEndDate: '2026-10-20' }, members.dev.id)
    const events = progressEvents(db, p.id)
    expect(events.length).toBe(baseline + 1)
    const evt = events.find((e) => e.summary.includes('出体验报告'))
    expect(evt).toBeTruthy()
    expect(evt.summary).toContain('🆕')
    expect(evt.nature).toBe('record')
    expect(evt.eventType).toBe('progress')
    expect(evt.status).toBe('effective')
    expect(evt.generatedBy).toBe('web')
    expect(evt.speakerMemberId).toBe(members.dev.id)
  })

  it('S59-2: updateTask 置 done → 落 record 型 progress 事件（✅）；非 done 状态流转不落', () => {
    const p = db.prepare('SELECT id FROM projects WHERE name = ?').get('进展项目')
    const t = db.prepare('SELECT id FROM tasks WHERE project_id = ? AND title = ?').get(p.id, '出体验报告')
    const before = progressEvents(db, p.id).length
    // 非 done 流转（todo → doing）不落进展
    updateTask(db, t.id, { status: 'doing' }, members.dev.id)
    expect(progressEvents(db, p.id).length).toBe(before)
    // doing → done 落进展
    updateTask(db, t.id, { status: 'done' }, members.dev.id)
    const events = progressEvents(db, p.id)
    expect(events.length).toBe(before + 1)
    const evt = events.find((e) => e.summary.includes('✅') && e.summary.includes('出体验报告'))
    expect(evt).toBeTruthy()
    expect(evt.generatedBy).toBe('web')
    expect(evt.status).toBe('effective')
  })

  it('S59-3: 建议确认经 applyTaskPatch 置 done → 事务内同步落 record 型 progress 事件（generatedBy=extraction）', () => {
    const p = db.prepare('SELECT id FROM projects WHERE name = ?').get('进展项目')
    const t = createTask(db, { projectId: p.id, title: '联调接口', planEndDate: '2026-10-22' }, members.dev.id)
    const before = progressEvents(db, p.id).length
    // 建议型事件（抽取面）：status=done 建议，pending 等人确认
    const sug = addEvent(db, {
      projectId: p.id, nature: 'suggestion', eventType: 'status_change',
      summary: '联调接口已完成', targetTaskId: t.id, targetField: 'status', targetValue: 'done',
      generatedBy: 'extraction', confidence: 0.9,
    })
    expect(sug.status).toBe('pending')
    expect(progressEvents(db, p.id).length).toBe(before) // 确认前不落
    confirmEvent(db, sug.id, members.lead.id) // 人确认生效
    const events = progressEvents(db, p.id)
    expect(events.length).toBe(before + 1)
    const evt = events.find((e) => e.summary.includes('✅') && e.summary.includes('联调接口'))
    expect(evt).toBeTruthy()
    expect(evt.generatedBy).toBe('extraction')
    // 任务状态真的被改了（原子性：同事务）
    expect(db.prepare('SELECT status FROM tasks WHERE id = ?').get(t.id).status).toBe('done')
  })

  it('S59-4: add_task 建议确认创建的任务不重复落进展（createTask 一处已落）；软删不进进展列', async () => {
    const p = db.prepare('SELECT id FROM projects WHERE name = ?').get('进展项目')
    // add_task 建议确认也走 createTask（proposals.js）——新增进展只在 createTask 落一次
    const t = createTask(db, { projectId: p.id, title: '补一条任务', planEndDate: '2026-10-25' }, members.admin.id)
    const afterCreate = progressEvents(db, p.id)
    expect(afterCreate.filter((e) => e.summary.includes('补一条任务')).length).toBe(1) // 只落一次
    // 软删不进进展列
    const { deleteTask } = await import('../engine/tasks.js')
    deleteTask(db, t.id, members.admin.id)
    const events = progressEvents(db, p.id)
    expect(events.filter((e) => e.summary.includes('补一条任务') && e.summary.includes('删除')).length).toBe(0)
  })
})
