import { describe, it, expect, afterAll } from 'vitest'
import { setupDb, seedMembers, setupApp, loginCookie, authed } from './helpers.mjs'
import { createProject, updateProject, closeProject, queryProjects } from '../engine/projects.js'
import { createTask, updateTask, deleteTask, tasksInventory } from '../engine/tasks.js'
import { weeklyBoard, setDayStatus } from '../engine/dailyBoard.js'
import { listEvents } from '../engine/events.js'
import { runWriteTool } from '../brain/bot/tools.js'
import { PROPOSAL_KINDS } from '../engine/proposals.js'
import { queryMetric } from '../engine/metrics.js'
import { myWork, myTasksBoard } from '../engine/statusBoard.js'
import { today, addDays, bjWeekStartMs, weekdayOf } from '../db/time.js'

// PRD S69（v0.80，K64）— 常态项目与每周执行周视图：projects.kind=routine + tasks.kind=routine（适用星期）
// + task_day_records 每日打卡（惰性 upsert，无记录=未做）+ 机器人 checkin_task + 结项豁免 + 口径隔离。

let db
let members
let routine // 常态项目（S69-1 建立后被后续用例共用）
let delivery // 交付项目（对照）
let dailyTask // 每天适用的常态任务（看资讯）
let monWedFriTask // 每周一、三、五的任务
afterAll(() => db?.close())

const ALL_WEEK = [1, 2, 3, 4, 5, 6, 7]

function seedRoutineProject() {
  return createProject(db, {
    name: '每日精进', kind: 'routine', typeCode: 'routine_ops', leadMemberId: members.lead.id,
    tasks: ['看资讯', { title: '周报整理', weekdays: [1, 3, 5] }],
  }, members.admin.id)
}

describe('S69 常态项目与每周执行周视图', () => {
  it('S69-1: 立项常态项目——kind/任务分类/适用星期落地；交付项目不受影响；类别不可变更；非法组合 400', () => {
    ;({ db } = setupDb())
    members = seedMembers(db)
    // 预置「常态项目」类型随 migration 0035 就位
    expect(db.prepare(`SELECT code FROM project_types WHERE code = 'routine_ops' AND status = 'active'`).get()).toBeTruthy()

    routine = seedRoutineProject()
    expect(routine.kind).toBe('routine')
    expect(routine.tasks.map((t) => t.kind)).toEqual(['routine', 'routine'])
    expect(routine.tasks.map((t) => t.weekdays)).toEqual([ALL_WEEK, [1, 3, 5]])
    // 常态任务无计划起止（无交付语义）
    for (const t of routine.tasks) {
      expect(t.planStartDate).toBeNull()
      expect(t.planEndDate).toBeNull()
    }
    dailyTask = routine.tasks[0]
    monWedFriTask = routine.tasks[1]

    // 交付项目缺省 kind='delivery'，任务缺省 work、无 weekdays
    delivery = createProject(db, { name: '交付对照', typeCode: 'lianmai_365', leadMemberId: members.lead.id }, members.admin.id)
    expect(delivery.kind).toBe('delivery')
    expect(delivery.tasks.every((t) => t.kind === 'work' && t.weekdays == null)).toBe(true)

    // 项目类别立项后不可变更（S69-1）
    expect(() => updateProject(db, routine.id, { kind: 'delivery' }, members.admin.id)).toThrow(/不可变更/)
    // 常态项目无交付日期/倒排（400）
    expect(() => createProject(db, { name: 'X', kind: 'routine', typeCode: 'routine_ops', leadMemberId: members.lead.id, planEndDate: '2026-12-31' }, members.admin.id)).toThrow(/常态项目/)
    expect(() => createProject(db, { name: 'X', kind: 'routine', typeCode: 'routine_ops', leadMemberId: members.lead.id, tasks: ['a'], autoSchedule: true, planEndDate: '2026-12-31' }, members.admin.id)).toThrow(/常态项目/)

    // 常态项目内建任务强制 routine（work/reminder 400）；routine 任务建在交付项目 400；常态任务无计划起止
    expect(() => createTask(db, { projectId: routine.id, title: '坏组合', kind: 'work' }, members.admin.id)).toThrow(/常态/)
    expect(() => createTask(db, { projectId: routine.id, title: '坏提醒', kind: 'reminder', planEndDate: today() }, members.admin.id)).toThrow(/常态/)
    expect(() => createTask(db, { projectId: delivery.id, title: '坏常驻', kind: 'routine' }, members.admin.id)).toThrow(/常态项目/)
    expect(() => createTask(db, { projectId: routine.id, title: '带排期', planEndDate: today() }, members.admin.id)).toThrow(/常态任务/)
    const added = createTask(db, { projectId: routine.id, title: '晚间复盘', weekdays: [2, 4] }, members.admin.id)
    expect(added.kind).toBe('routine')
    expect(added.weekdays).toEqual([2, 4])
    deleteTask(db, added.id, members.admin.id)
  })

  it('S69-2: 周视图取数——默认当前北京自然周、week 定位任意周、格子矩阵与不适用日；路由可用', async () => {
    const monday = today(bjWeekStartMs())
    const board = weeklyBoard(db, routine.id)
    expect(board.weekStart).toBe(monday)
    expect(board.days).toHaveLength(7)
    expect(board.days[0]).toBe(monday)
    expect(board.days[6]).toBe(addDays(monday, 6))
    expect(board.tasks.map((t) => t.taskId)).toEqual(routine.tasks.map((t) => t.id))

    const daily = board.tasks.find((t) => t.taskId === dailyTask.id)
    expect(daily.weekdays).toEqual(ALL_WEEK)
    expect(daily.weekdaysLabel).toBe('每天')
    expect(daily.cells.every((c) => c.applicable)).toBe(true)
    expect(daily.cells.every((c) => c.status === 'pending' && c.note === null)).toBe(true)

    const mwf = board.tasks.find((t) => t.taskId === monWedFriTask.id)
    expect(mwf.weekdaysLabel).toBe('每周一、三、五')
    expect(mwf.cells.map((c) => c.applicable)).toEqual([true, false, true, false, true, false, false])

    // week=任意日定位所在周（周三 → 本周一）；汇总统计结构齐全
    const shifted = weeklyBoard(db, routine.id, { weekAnchor: addDays(monday, 16) }) // 下下周三
    expect(shifted.weekStart).toBe(addDays(monday, 14))
    expect(shifted.summary).toMatchObject({ tasks: 2, applicableCells: 10 }) // 每天 7 + 周一三五 3
    expect(shifted.summary.perDay).toHaveLength(7)

    // 非常态项目 400 / 项目不存在 404
    expect(() => weeklyBoard(db, delivery.id)).toThrow(/常态/)
    expect(() => weeklyBoard(db, 99999)).toThrow(/不存在/)
    expect(() => weeklyBoard(db, routine.id, { weekAnchor: '2026-13-40' })).toThrow(/日历日/)

    // 路由层：GET/POST daily-board（登录态）
    const { app, db: appDb, members: appMembers } = await setupApp()
    try {
      const p = createProject(appDb, { name: '路由常态', kind: 'routine', typeCode: 'routine_ops', leadMemberId: appMembers.lead.id, tasks: ['晨读'] }, appMembers.admin.id)
      const t = appDb.prepare('SELECT id FROM tasks WHERE project_id = ?').get(p.id)
      const cookie = await loginCookie(app, 'zhangsan', 'pass-123456')
      const got = await authed(app, cookie, 'GET', `/api/v1/projects/${p.id}/daily-board`)
      expect(got.status).toBe(200)
      expect(got.body.weekStart).toBe(monday)
      expect(got.body.tasks[0].taskId).toBe(t.id)
      const posted = await authed(app, cookie, 'POST', `/api/v1/projects/${p.id}/daily-board`, { taskId: t.id, day: today(), status: 'done', note: '第 1 章' })
      expect(posted.status).toBe(201)
      expect(posted.body.status).toBe('done')
      const bad = await authed(app, cookie, 'POST', `/api/v1/projects/${p.id}/daily-board`, { taskId: t.id, day: addDays(today(), 1), status: 'done' })
      expect(bad.status).toBe(400)
      const unauth = await app.inject({ method: 'GET', url: `/api/v1/projects/${p.id}/daily-board` })
      expect(unauth.statusCode).toBe(401)
    } finally {
      app.db.close()
    }
  })

  it('S69-3: 打卡三态互转——完成/跳过/重置删行；补过去/拒未来；不适用星期与超长备注 400；事件留痕；终态只读', () => {
    const day = today()
    // done → 落行 + record 型 progress 事件（append-only）
    let cell = setDayStatus(db, { projectId: routine.id, taskId: dailyTask.id, day, status: 'done', note: '读完 3 篇' }, members.dev.id)
    expect(cell.status).toBe('done')
    expect(cell.note).toBe('读完 3 篇')
    expect(cell.operatorName).toBe('李四')
    expect(db.prepare('SELECT COUNT(*) AS n FROM task_day_records WHERE task_id = ? AND day = ?').get(dailyTask.id, day).n).toBe(1)
    let evts = listEvents(db, { projectId: routine.id })
    expect(evts.some((e) => e.nature === 'record' && e.eventType === 'progress' && e.status === 'effective' && e.summary.includes('看资讯') && e.summary.includes(day))).toBe(true)

    // done → skip：同行更新（唯一键），事件追加
    cell = setDayStatus(db, { projectId: routine.id, taskId: dailyTask.id, day, status: 'skip', note: '' }, members.dev.id)
    expect(cell.status).toBe('skip')
    expect(db.prepare('SELECT COUNT(*) AS n FROM task_day_records WHERE task_id = ?').get(dailyTask.id).n).toBe(1)
    expect(listEvents(db, { projectId: routine.id }).filter((e) => e.summary.includes('看资讯')).length).toBe(2)

    // skip → pending：重置=删行（无记录=未做）
    cell = setDayStatus(db, { projectId: routine.id, taskId: dailyTask.id, day, status: 'pending' }, members.dev.id)
    expect(cell.status).toBe('pending')
    expect(db.prepare('SELECT COUNT(*) AS n FROM task_day_records WHERE task_id = ?').get(dailyTask.id).n).toBe(0)

    // 幂等重置：无行再 pending 不产事件
    const before = listEvents(db, { projectId: routine.id }).length
    setDayStatus(db, { projectId: routine.id, taskId: dailyTask.id, day, status: 'pending' }, members.dev.id)
    expect(listEvents(db, { projectId: routine.id }).length).toBe(before)

    // 补过去日期（上周同星期）；拒绝未来日期
    const past = addDays(day, -7)
    expect(weekdayOf(past)).toBe(weekdayOf(day))
    setDayStatus(db, { projectId: routine.id, taskId: dailyTask.id, day: past, status: 'done' }, members.dev.id)
    expect(() => setDayStatus(db, { projectId: routine.id, taskId: dailyTask.id, day: addDays(day, 1), status: 'done' }, members.dev.id)).toThrow(/未来/)

    // 不适用星期 400（建一条「只在非今日星期」的任务，今天打即拒）
    const other = (weekdayOf(day) % 7) + 1 // 必 ≠ 今日星期
    const odd = createTask(db, { projectId: routine.id, title: '错位任务', weekdays: [other] }, members.admin.id)
    expect(() => setDayStatus(db, { projectId: routine.id, taskId: odd.id, day, status: 'done' }, members.dev.id)).toThrow(/不适用/)
    deleteTask(db, odd.id, members.admin.id)

    // 交付项目任务/非法枚举/超长备注
    expect(() => setDayStatus(db, { projectId: delivery.id, taskId: delivery.tasks[0].id, day, status: 'done' }, members.dev.id)).toThrow(/常态/)
    expect(() => setDayStatus(db, { projectId: routine.id, taskId: dailyTask.id, day, status: 'oops' }, members.dev.id)).toThrow(/invalid/)
    expect(() => setDayStatus(db, { projectId: routine.id, taskId: dailyTask.id, day, status: 'done', note: 'x'.repeat(201) }, members.dev.id)).toThrow(/200/)

    // 终态只读（取消后 409）
    const frozen = createProject(db, { name: '冻结常态', kind: 'routine', typeCode: 'routine_ops', leadMemberId: members.lead.id, tasks: ['冻结项'] }, members.admin.id)
    db.prepare(`UPDATE projects SET status = 'cancelled' WHERE id = ?`).run(frozen.id)
    expect(() => setDayStatus(db, { projectId: frozen.id, taskId: frozen.tasks[0].id, day, status: 'done' }, members.dev.id)).toThrow(/409|只读/)

    // 留痕进审计
    expect(db.prepare(`SELECT 1 FROM audit_logs WHERE action = 'task.dayStatus' AND object_id = ?`).get(String(dailyTask.id))).toBeTruthy()
  })

  it('S69-4: 机器人 checkin_task——taskId/任务名唯一命中、多义拒绝、缺省今天、批量与失败如实转告', async () => {
    const ctx = {
      member: members.dev,
      evt: { ts: Date.now(), text: '看资讯打卡', messageId: 'om_s69', chatType: 'p2p', platform: 'feishu' },
      sourcePlatform: 'feishu',
    }
    const day = today()

    // 任务名精确命中：直接生效并回执（K25），缺省 day=今天、status=done
    let out = await runWriteTool(db, { kind: 'checkin_task', payload: { projectId: routine.id, taskTitle: '看资讯' } }, ctx)
    expect(out.type).toBe('receipt')
    expect(out.text).toContain('已打卡')
    expect(out.text).toContain('看资讯')
    expect(db.prepare(`SELECT status FROM task_day_records WHERE task_id = ? AND day = ?`).get(dailyTask.id, day)?.status).toBe('done')
    // 事件归因 bot 通道（source_platform=feishu、generated_by=agent、speaker=发令人）
    const evt = listEvents(db, { projectId: routine.id }).find((e) => e.summary.includes(day) && e.summary.includes('看资讯') && e.sourcePlatform === 'feishu')
    expect(evt?.generatedBy).toBe('agent')
    expect(evt?.speakerMemberId).toBe(members.dev.id)

    // 模糊子串唯一命中 + skip + 备注
    out = await runWriteTool(db, { kind: 'checkin_task', payload: { projectId: routine.id, taskHint: '资讯', status: 'skip', note: '出差' } }, ctx)
    expect(out.type).toBe('receipt')
    expect(db.prepare(`SELECT status, note FROM task_day_records WHERE task_id = ? AND day = ?`).get(dailyTask.id, day)).toMatchObject({ status: 'skip', note: '出差' })

    // pending 重置（删行）
    out = await runWriteTool(db, { kind: 'checkin_task', payload: { projectId: routine.id, taskId: dailyTask.id, status: 'pending' } }, ctx)
    expect(out.type).toBe('receipt')
    expect(db.prepare(`SELECT COUNT(*) AS n FROM task_day_records WHERE task_id = ?`).get(dailyTask.id).n).toBe(1) // 仅剩上周补卡行

    // 多义：拒绝并列候选
    createTask(db, { projectId: routine.id, title: '资讯晚报' }, members.admin.id)
    out = await runWriteTool(db, { kind: 'checkin_task', payload: { projectId: routine.id, taskHint: '资讯' } }, ctx)
    expect(out.type).toBe('refused')
    expect(out.text).toContain('#')

    // 批量 items：逐条生效汇总回执；坏行单列失败原因
    out = await runWriteTool(db, {
      kind: 'checkin_task',
      payload: { projectId: routine.id, items: [
        { taskTitle: '看资讯', status: 'done' },
        { taskTitle: '不存在任务', status: 'done' },
      ] },
    }, ctx)
    expect(out.type).toBe('receipt')
    expect(out.text).toContain('1 项')
    expect(out.text).toContain('失败 1 项')

    // 失败如实转告：未来日期 / 交付项目任务 / 未给定位
    out = await runWriteTool(db, { kind: 'checkin_task', payload: { projectId: routine.id, taskId: dailyTask.id, day: addDays(day, 2), status: 'done' } }, ctx)
    expect(out.type).toBe('refused')
    expect(out.text).toContain('未来')
    out = await runWriteTool(db, { kind: 'checkin_task', payload: { projectId: delivery.id, taskId: delivery.tasks[0].id } }, ctx)
    expect(out.type).toBe('refused')
    out = await runWriteTool(db, { kind: 'checkin_task', payload: { projectId: routine.id } }, ctx)
    expect(out.type).toBe('refused')
  })

  it('S69-5: 常态项目手动结项豁免「全部任务完成」——总结仍必填；结项后周视图可读、打卡/任务面只读；交付项目校验不变', () => {
    expect(() => closeProject(db, routine.id, {}, members.admin.id)).toThrow(/总结/)
    const closed = closeProject(db, routine.id, { summary: '常态化阶段收尾' }, members.admin.id)
    expect(closed.status).toBe('closed')

    // 周视图仍可读（历史可查），打卡与任务面只读
    const board = weeklyBoard(db, routine.id)
    expect(board.tasks.length).toBe(3) // 看资讯/周报整理/资讯晚报
    expect(() => setDayStatus(db, { projectId: routine.id, taskId: dailyTask.id, day: today(), status: 'done' }, members.admin.id)).toThrow(/409|只读/)
    expect(() => updateTask(db, dailyTask.id, { title: '改名' }, members.admin.id)).toThrow(/409|只读/)

    // 交付项目结项校验不变（存在未完成任务 409）
    expect(() => closeProject(db, delivery.id, { summary: 'x' }, members.admin.id)).toThrow(/未完成/)
  })

  it('S69-6: 口径隔离——常态任务退出指标/我的任务/盘点；组合页进度不计；不预生成实例', () => {
    // 干净对照：交付项目 1 条逾期工作（关键人王五），常态任务也挂在王五名下
    const p2 = createProject(db, { name: '口径对照', typeCode: 'lianmai_365', leadMemberId: members.lead.id }, members.admin.id)
    db.prepare(`UPDATE tasks SET deleted_at = ? WHERE project_id = ? AND deleted_at IS NULL`).run(Date.now(), p2.id)
    createTask(db, { projectId: p2.id, title: '逾期工作', responsibleMemberId: members.key.id, planStartDate: addDays(today(), -5), planEndDate: addDays(today(), -1) }, members.admin.id)

    const routine2 = createProject(db, {
      name: '口径常态', kind: 'routine', typeCode: 'routine_ops', leadMemberId: members.key.id,
      tasks: [{ title: '每日巡检', weekdays: ALL_WEEK }],
    }, members.admin.id)
    updateTask(db, routine2.tasks[0].id, { responsibleMemberId: members.key.id }, members.admin.id)

    // 指标：逾期/健康度/关键人负载的 openTasks 只数工作类
    const od = queryMetric(db, 'overdue_tasks', { groupBy: 'project' }).rows.find((r) => r.project === '口径常态')
    expect(od ?? { overdue: 0, openTasks: 0 }).toMatchObject({ overdue: 0, openTasks: 0 })
    const health = queryMetric(db, 'project_health').rows.find((r) => r.project === '口径常态')
    expect(health.overdueTasks).toBe(0)
    const load = queryMetric(db, 'keyperson_load', { groupBy: 'member' }).rows.find((r) => r.member === '王五')
    expect(load.openTasks).toBe(1)

    // /my 与 S66 工作台不计常态任务（永不完成，计入即永久噪音）
    expect(myWork(db, members.key.id).text).not.toContain('每日巡检')
    expect(JSON.stringify(myTasksBoard(db, members.key.id))).not.toContain('每日巡检')

    // 盘点：常态项目按「常态清单」呈现（不冠「未完」）；全局未分配盘点不计常态任务
    const inv = tasksInventory(db, { projectId: routine2.id })
    expect(inv.text).toContain('常态')
    expect(inv.text).toContain('每日巡检')
    expect(inv.text).not.toContain('未完')
    expect(tasksInventory(db).text).not.toContain('每日巡检')

    // 组合页任务进度（kind='work' 口径）：常态项目 0/—
    const row = queryProjects(db).projects.find((r) => r.id === routine2.id)
    expect(row.tasksTotal).toBe(0)

    // 不预生成实例：无打卡记录行 = 未做
    expect(db.prepare('SELECT COUNT(*) AS n FROM task_day_records WHERE task_id = ?').get(routine2.tasks[0].id).n).toBe(0)
  })

  it('S69-7: 任务行维护——星期可改（≥1 天）、状态/排期 patch 400、机器人 add_task 自动 routine、软删退出周视图', () => {
    const live = createProject(db, { name: '维护常态', kind: 'routine', typeCode: 'routine_ops', leadMemberId: members.lead.id, tasks: ['维护项'] }, members.admin.id)
    const t = live.tasks[0]

    updateTask(db, t.id, { weekdays: [2, 4, 6] }, members.admin.id)
    expect(db.prepare('SELECT weekdays FROM tasks WHERE id = ?').get(t.id).weekdays).toBe('2,4,6')
    expect(() => updateTask(db, t.id, { weekdays: [] }, members.admin.id)).toThrow(/至少/)
    expect(() => updateTask(db, t.id, { weekdays: [0] }, members.admin.id)).toThrow(/1~7/)
    expect(() => updateTask(db, t.id, { status: 'done' }, members.admin.id)).toThrow(/常态任务/)
    expect(() => updateTask(db, t.id, { planEndDate: today() }, members.admin.id)).toThrow(/常态任务/)
    // 交付项目任务不可设星期
    expect(() => updateTask(db, delivery.tasks[0].id, { weekdays: [1] }, members.admin.id)).toThrow(/常态/)

    // 机器人 add_task 提议生效链路对常态项目自动 routine（无 taskKind/排期语义）
    const viaProposal = PROPOSAL_KINDS.add_task.apply(db, { projectId: live.id, title: '群内新增常态', weekdays: [1, 2] }, members.admin.id)
    expect(viaProposal.kind).toBe('routine')
    expect(viaProposal.weekdays).toEqual([1, 2])

    // 软删退出周视图
    deleteTask(db, viaProposal.id, members.admin.id)
    const board = weeklyBoard(db, live.id)
    expect(board.tasks.map((x) => x.taskId)).toEqual([t.id])
  })
})
