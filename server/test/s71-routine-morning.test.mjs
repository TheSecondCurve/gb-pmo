import { describe, it, expect, afterAll } from 'vitest'
import { setupDb, seedMembers } from './helpers.mjs'
import { createProject } from '../engine/projects.js'
import { createTask, upsertChannel } from '../engine/tasks.js'
import { addEvent } from '../engine/events.js'
import { dailyProjectMorningPush } from '../brain/morningPush.js'
import { setDayStatus } from '../engine/dailyBoard.js'
import { today, addDays, weekdayOf } from '../db/time.js'

// PRD S71（v0.83，K67）— 常态项目晨报专用版：morningPush 按 projects.kind 分叉——
// 常态版 = 说明行（默认归属人 + 可协助打卡）+【今日待办】（适用星期判定，逐条带打卡状态，
// 未做排前）+【明日待办】（纯预览）+【昨日以来动态】；取数与周视图同源；不经 LLM；
// 交付项目四节骨架原样；幂等/守卫沿用 S68。

let db
let members
afterAll(() => db?.close())

function fakeSend(sink) {
  return async (payload) => {
    sink.push(payload)
    return { messageId: `om_${sink.length}` }
  }
}

/** 出站 post 富文本拍平为纯文本（断言用）。 */
const flatText = (m) => (m.post ? (m.post.zh_cn?.content || []).flat().map((r) => r?.text || '').join('\n') : m.text || '')

/** 常态项目：模板任务清场（口径断言要精确基数，被测任务全部显式创建）。 */
function seedRoutineProject(name, { channel = true } = {}) {
  const p = createProject(db, { name, typeCode: 'lianmai_365', leadMemberId: members.lead.id, kind: 'routine' }, members.admin.id)
  db.prepare(`UPDATE tasks SET deleted_at = ? WHERE project_id = ? AND deleted_at IS NULL`).run(Date.now(), p.id)
  if (channel) upsertChannel(db, { platform: 'feishu', groupKey: `oc_${p.id}`, channelType: 'dedicated', projectId: p.id })
  return p
}

/** 星期无关的确定性构造：todayWd/tomorrowWd 实时计算，保证任何运行日断言稳定。 */
function wdNotIn(set) {
  for (const wd of [1, 2, 3, 4, 5, 6, 7]) if (!set.includes(wd)) return wd
}

describe('S71 常态项目晨报专用版', () => {
  it('S71-1/S71-2/S71-3/S71-4: 常态项目专用盘面 + 交付对照不变——今日/明日待办、默认归属人、不经 LLM', async () => {
    ;({ db } = setupDb())
    members = seedMembers(db)
    const todayStr = today()
    const tomorrowStr = addDays(todayStr, 1)
    const todayWd = weekdayOf(todayStr)
    const tomorrowWd = weekdayOf(tomorrowStr)

    const p = seedRoutineProject('常态晨报项目')
    const taskAlways = createTask(db, { projectId: p.id, title: '看资讯早报', responsibleMemberId: members.dev.id }, members.admin.id) // 每天适用
    const taskTodayOnly = createTask(db, { projectId: p.id, title: '私董群答疑', responsibleMemberId: members.lead.id, weekdays: [todayWd] }, members.admin.id)
    createTask(db, { projectId: p.id, title: '背单词', weekdays: [tomorrowWd] }, members.admin.id) // 未指派，仅明日适用
    createTask(db, { projectId: p.id, title: '数据巡检', responsibleMemberId: members.dev.id }, members.admin.id) // 每天适用、未打卡
    setDayStatus(db, { projectId: p.id, taskId: taskAlways.id, day: todayStr, status: 'done' }, members.dev.id)
    setDayStatus(db, { projectId: p.id, taskId: taskTodayOnly.id, day: todayStr, status: 'skip' }, members.lead.id)
    addEvent(db, { projectId: p.id, nature: 'record', eventType: 'progress', summary: '周视图上线', sourcePlatform: 'feishu', speakerLabel: '张三' })

    // 同批放一个交付项目：四节骨架 + LLM 综述正常（对照组）
    const dp = createProject(db, { name: '交付对照项目', typeCode: 'lianmai_365', leadMemberId: members.lead.id }, members.admin.id)
    db.prepare(`UPDATE tasks SET deleted_at = ? WHERE project_id = ? AND deleted_at IS NULL`).run(Date.now(), dp.id)
    createTask(db, { projectId: dp.id, title: '逾期联调', responsibleMemberId: members.dev.id, planEndDate: addDays(todayStr, -1) }, members.admin.id)
    upsertChannel(db, { platform: 'feishu', groupKey: `oc_${dp.id}`, channelType: 'dedicated', projectId: dp.id })

    let llmCalls = 0
    const fakeLlm = { name: 'fake', complete: async () => { llmCalls += 1; return '综述一句话。' } }
    const sent = []
    await dailyProjectMorningPush(db, { llm: fakeLlm, send: fakeSend(sent) })

    const routineMsg = sent.find((m) => m.chatId === `oc_${p.id}`)
    expect(routineMsg).toBeTruthy()
    const body = flatText(routineMsg)
    // 结构：说明行 + 三节；不出现交付版节
    expect(body).toContain('今日待办')
    expect(body).toContain('明日待办')
    expect(body).toContain('昨日以来动态')
    for (const absent of ['项目概况', '逾期任务', '近期开工']) expect(body).not.toContain(absent)
    // 措辞：默认归属人 + 协助说明 + 未指派如实标注
    expect(body).toContain('默认归属人：李四')
    expect(body).toContain('默认归属人：张三')
    expect(body).toContain('默认归属人：未指派')
    expect(body).toContain('其他成员可协助打卡')
    // 今日：适用=每天两张 + 今日专属；未做排前 → 数据巡检 < 私董群答疑(跳过) < 看资讯早报(已完成)；背单词不在今日
    const iPending = body.indexOf('数据巡检')
    const iSkip = body.indexOf('私董群答疑')
    const iDone = body.indexOf('看资讯早报')
    expect(iPending).toBeGreaterThanOrEqual(0)
    expect(iPending).toBeLessThan(iSkip)
    expect(iSkip).toBeLessThan(iDone)
    expect(body).toContain('✓ 已完成')
    expect(body).toContain('⤴ 跳过')
    const iTomorrow = body.indexOf('明日待办')
    expect(body.indexOf('背单词')).toBeGreaterThan(iTomorrow) // 背单词只出现在明日节，不在今日
    // 节头计数：今日共 3 项、未做 1 / 跳过 1 / 已完成 1
    expect(body).toContain('共 3 项')
    expect(body).toContain('未做 1')
    expect(body).toContain('跳过 1')
    expect(body).toContain('已完成 1')
    // 动态节保留（置尾，昨日以来）
    expect(body).toContain('周视图上线')
    // LLM：仅交付项目调用 1 次，常态项目零调用
    expect(llmCalls).toBe(1)
    // 交付对照：四节骨架原样
    const dMsg = sent.find((m) => m.chatId === `oc_${dp.id}`)
    const dBody = flatText(dMsg)
    expect(dBody).toContain('项目概况')
    expect(dBody).toContain('逾期任务')
    expect(dBody).toContain('综述一句话。')
    // pushes 落行与交付版同口径
    const row = db.prepare(`SELECT * FROM pushes WHERE push_type = 'morning' AND related_project_id = ?`).get(p.id)
    expect(row).toBeTruthy()
    expect(row.status).toBe('sent')
    expect(row.group_key).toBe(`oc_${p.id}`)
  })

  it('S71-2: 当日无适用任务 → 明确空态行（不编造）', async () => {
    const todayStr = today()
    const otherWd = wdNotIn([weekdayOf(todayStr), weekdayOf(addDays(todayStr, 1))])
    const p = seedRoutineProject('常态空态项目')
    createTask(db, { projectId: p.id, title: '只在不相关日子', weekdays: [otherWd] }, members.admin.id)
    const sent = []
    await dailyProjectMorningPush(db, { send: fakeSend(sent) })
    const body = flatText(sent.find((m) => m.chatId === `oc_${p.id}`))
    expect(body).toContain('今日无适用任务')
    expect(body).toContain('明日无适用任务')
    expect(body.slice(0, body.indexOf('昨日以来动态'))).not.toContain('只在不相关日子') // 待办两节不编造；任务标题只允许出现在动态事件里
  })

  it('S71-5: 幂等与守卫沿用 S68——当日已推跳过、无专题群跳过', async () => {
    const p1 = seedRoutineProject('常态幂等项目')
    createTask(db, { projectId: p1.id, title: '每日签到' }, members.admin.id)
    const p2 = seedRoutineProject('常态无群项目', { channel: false })
    const first = await dailyProjectMorningPush(db, { send: fakeSend([]) })
    const second = await dailyProjectMorningPush(db, { send: fakeSend([]) })
    const r1first = first.results.find((r) => r.projectId === p1.id)
    const r1second = second.results.find((r) => r.projectId === p1.id)
    const r2 = first.results.find((r) => r.projectId === p2.id)
    expect(r1first.pushed).toBe(true)
    expect(r1second.skipped).toBe(true)
    expect(r1second.reason).toContain('今日已推送')
    expect(r2.skipped).toBe(true)
    expect(r2.reason).toContain('无绑定专题群')
  })
})
