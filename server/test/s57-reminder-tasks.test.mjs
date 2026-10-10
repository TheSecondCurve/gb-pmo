import { describe, it, expect, afterAll } from 'vitest'
import { setupDb, seedMembers } from './helpers.mjs'
import { createProject } from '../engine/projects.js'
import { listProjects } from '../engine/projects.js'
import { createTask, updateTask, listTaskRecords, overdueTasksOf, tasksInventory, upsertChannel } from '../engine/tasks.js'
import { PROPOSAL_KINDS } from '../engine/proposals.js'
import { evaluateReminders } from '../brain/reminder.js'
import { queryMetric } from '../engine/metrics.js'
import { projectBrief } from '../engine/brief.js'
import { myWork } from '../engine/statusBoard.js'
import { today, addDays, bjDayStartMs } from '../db/time.js'

// PRD S57（v0.62，K40）— 纯提醒任务分类：到期一次性推送（责任人私聊 + 项目专题群）后自动完成，
// 不进逾期追踪口径；幂等锚点 reminded_at；补发/门槛/边界；追踪口径只认 kind='work'。

let db
let members
afterAll(() => db?.close())

// 北京 10:00（过默认 fireAfterHour=9 门槛）/ 07:30（未过）——now 注入固定小时，
// 测试任意时刻跑都稳定（日期本身用真实今天，与 BJ_TODAY() 同源）。
const atHour = (h) => () => bjDayStartMs(Date.now()) + h * 3_600_000

function fakeSend(sink) {
  return async (payload) => {
    sink.push(payload)
    return { messageId: `om_${sink.length}` }
  }
}

function seedProject(name) {
  return createProject(db, { name, typeCode: 'lianmai_365', leadMemberId: members.lead.id }, members.admin.id)
}

describe('S57 纯提醒任务分类', () => {
  it('S57-1: 到期触发——责任人私聊 + 项目专题群各一次，发完自动完成并留痕；同日再跑不重发', async () => {
    ;({ db } = setupDb())
    members = seedMembers(db)
    const p = seedProject('提醒主项目')
    upsertChannel(db, { platform: 'feishu', groupKey: 'oc_rem', name: '提醒主项目群', channelType: 'dedicated', projectId: p.id })
    const t = createTask(db, {
      projectId: p.id, title: '评审会提醒', kind: 'reminder',
      responsibleMemberId: members.dev.id, planEndDate: today(),
    }, members.admin.id)

    const sent = []
    const { reminders } = await evaluateReminders(db, { send: fakeSend(sent), now: atHour(10) })
    expect(reminders.length).toBe(1)

    // 推送落痕：一条责任人私聊（recipient=成员）+ 一条群推送（group_key 非空、recipient 空）
    const rows = db.prepare(`SELECT * FROM pushes WHERE push_type = 'reminder' AND related_project_id = ?`).all(p.id)
    expect(rows.length).toBe(2)
    const priv = rows.find((r) => r.recipient_member_id === members.dev.id)
    const grp = rows.find((r) => r.group_key === 'oc_rem')
    expect(priv?.status).toBe('sent')
    expect(grp?.recipient_member_id).toBeNull()
    expect(grp?.status).toBe('sent')
    // 注入发送器收到两个目标：私聊 openId + 群 chatId
    expect(sent.some((s) => s.openId === members.dev.feishuId)).toBe(true)
    expect(sent.some((s) => s.chatId === 'oc_rem')).toBe(true)

    // 发完自动完成：done + actual_end_date=今日 + reminded_at 幂等锚点 + 时间线留痕
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(t.id)
    expect(row.status).toBe('done')
    expect(row.actual_end_date).toBe(today())
    expect(row.reminded_at).toBeTruthy()
    expect(listTaskRecords(db, t.id).some((r) => r.content.includes('系统提醒已送达'))).toBe(true)
    expect(db.prepare(`SELECT 1 FROM audit_logs WHERE action = 'task.remind' AND object_id = ?`).get(String(t.id))).toBeTruthy()

    // 幂等：同日再跑不重发
    const sent2 = []
    const again = await evaluateReminders(db, { send: fakeSend(sent2), now: atHour(10) })
    expect(again.reminders.length).toBe(0)
    expect(sent2.length).toBe(0)
  })

  it('S57-2: 未到提醒日/未过发送门槛不触发；过期未发（停机跨日、补录）补发一次', async () => {
    const p = db.prepare(`SELECT id FROM projects WHERE name = ?`).get('提醒主项目')
    // 未来提醒日：不触发
    const future = createTask(db, { projectId: p.id, title: '下周对齐提醒', kind: 'reminder', planEndDate: addDays(today(), 3) }, members.admin.id)
    // 今日到期但未过 09:00 门槛：不触发
    const gated = createTask(db, { projectId: p.id, title: '门槛内提醒', kind: 'reminder', planEndDate: today() }, members.admin.id)
    let sink = []
    let r = await evaluateReminders(db, { send: fakeSend(sink), now: atHour(7.5) })
    expect(r.reminders.length).toBe(0)
    expect(sink.length).toBe(0)
    // 过门槛后：今日到期的发，未来的仍不发
    r = await evaluateReminders(db, { send: fakeSend(sink), now: atHour(10) })
    expect(r.reminders.map((x) => x.taskId)).toEqual([gated.id])
    // 过期未发（提醒日 < 今日）：下个周期补发一次
    const late = createTask(db, { projectId: p.id, title: '补发提醒', kind: 'reminder', planEndDate: addDays(today(), -2) }, members.admin.id)
    sink = []
    r = await evaluateReminders(db, { send: fakeSend(sink), now: atHour(10) })
    expect(r.reminders.map((x) => x.taskId)).toEqual([late.id])
    expect(db.prepare('SELECT status FROM tasks WHERE id = ?').get(future.id).status).toBe('todo')
  })

  it('S57-3: 责任人未指派只发群；项目无绑定渠道只发私聊；终态项目不触发', async () => {
    const p = db.prepare(`SELECT id FROM projects WHERE name = ?`).get('提醒主项目')
    // 未指派责任人：只发群（1 条群推送，无私聊行）
    const noOwner = createTask(db, { projectId: p.id, title: '无主提醒', kind: 'reminder', planEndDate: today() }, members.admin.id)
    let sink = []
    let r = await evaluateReminders(db, { send: fakeSend(sink), now: atHour(10) })
    expect(r.reminders.map((x) => x.taskId)).toEqual([noOwner.id])
    expect(sink.every((s) => s.chatId)).toBe(true) // 全部发往群，无私聊载荷
    const rows = db.prepare(`SELECT * FROM pushes WHERE push_type = 'reminder' AND related_project_id = ? AND title LIKE ?`).all(p.id, '%无主提醒%')
    expect(rows.filter((x) => x.group_key).length).toBe(1)
    expect(rows.some((x) => x.recipient_member_id)).toBe(false)

    // 无绑定专题渠道的项目：只发责任人私聊
    const p2 = seedProject('无渠道项目')
    const noCh = createTask(db, { projectId: p2.id, title: '无群提醒', kind: 'reminder', responsibleMemberId: members.dev.id, planEndDate: today() }, members.admin.id)
    sink = []
    r = await evaluateReminders(db, { send: fakeSend(sink), now: atHour(10) })
    expect(r.reminders.map((x) => x.taskId)).toEqual([noCh.id])
    expect(sink.every((s) => s.openId)).toBe(true) // 只有私聊载荷
    expect(db.prepare(`SELECT COUNT(*) AS n FROM pushes WHERE push_type = 'reminder' AND related_project_id = ?`).get(p2.id).n).toBe(1)

    // 离职责任人：建时在职、送达前离职 → 跳过私聊只发群
    const p3 = seedProject('离职责任人项目')
    upsertChannel(db, { platform: 'feishu', groupKey: 'oc_off', channelType: 'dedicated', projectId: p3.id })
    createTask(db, { projectId: p3.id, title: '离职提醒', kind: 'reminder', responsibleMemberId: members.dev.id, planEndDate: today() }, members.admin.id)
    db.prepare(`UPDATE members SET status = 'offboarded' WHERE id = ?`).run(members.dev.id)
    sink = []
    r = await evaluateReminders(db, { send: fakeSend(sink), now: atHour(10) })
    expect(r.reminders.length).toBe(1)
    expect(sink.every((s) => s.chatId)).toBe(true)
    db.prepare(`UPDATE members SET status = 'active' WHERE id = ?`).run(members.dev.id)

    // 终态项目：建时在跑、送达前结项 → 不触发（任务面冻结，S29）
    const p4 = seedProject('结项项目')
    const frozen = createTask(db, { projectId: p4.id, title: '冻结提醒', kind: 'reminder', planEndDate: addDays(today(), -1) }, members.admin.id)
    db.prepare(`UPDATE projects SET status = 'closed' WHERE id = ?`).run(p4.id)
    sink = []
    r = await evaluateReminders(db, { send: fakeSend(sink), now: atHour(10) })
    expect(r.reminders.length).toBe(0)
    expect(db.prepare('SELECT status FROM tasks WHERE id = ?').get(frozen.id).status).toBe('todo')
  })

  it('S57-4: kind=work 永不进提醒扫描；提醒改期/人工重开重置幂等锚点再次触发', async () => {
    const p = db.prepare(`SELECT id FROM projects WHERE name = ?`).get('提醒主项目')
    // 工作任务过期：不进提醒扫描（仍走 S7 逾期追踪口径）
    const work = createTask(db, { projectId: p.id, title: '过期工作', responsibleMemberId: members.admin.id, planEndDate: addDays(today(), -1) }, members.admin.id)
    let r = await evaluateReminders(db, { send: fakeSend([]), now: atHour(10) })
    expect(r.reminders.length).toBe(0)
    expect(overdueTasksOf(db, members.admin.id).some((x) => x.id === work.id)).toBe(true)

    // 触发一次后人工重开：锚点重置，同日可再次触发（重开=要再提醒一次）
    const t = createTask(db, { projectId: p.id, title: '重开提醒', kind: 'reminder', planEndDate: today() }, members.admin.id)
    await evaluateReminders(db, { send: fakeSend([]), now: atHour(10) })
    expect(db.prepare('SELECT reminded_at FROM tasks WHERE id = ?').get(t.id).reminded_at).toBeTruthy()
    updateTask(db, t.id, { status: 'todo' }, members.admin.id)
    expect(db.prepare('SELECT reminded_at, status FROM tasks WHERE id = ?').get(t.id).reminded_at).toBeNull()
    r = await evaluateReminders(db, { send: fakeSend([]), now: atHour(10) })
    expect(r.reminders.map((x) => x.taskId)).toEqual([t.id])

    // 改期到未来：锚点重置但状态 done，不到日不触发
    await evaluateReminders(db, { send: fakeSend([]), now: atHour(10) })
    updateTask(db, t.id, { planEndDate: addDays(today(), 5) }, members.admin.id)
    expect(db.prepare('SELECT reminded_at FROM tasks WHERE id = ?').get(t.id).reminded_at).toBeNull()
    r = await evaluateReminders(db, { send: fakeSend([]), now: atHour(10) })
    expect(r.reminders.length).toBe(0)
  })

  it('S57-5: 非法 kind 拒绝；缺省 work；建任务入口（提议生效）透传 kind', async () => {
    const p = db.prepare(`SELECT id FROM projects WHERE name = ?`).get('提醒主项目')
    expect(() => createTask(db, { projectId: p.id, title: '坏分类', kind: 'oops' }, members.admin.id)).toThrow(/invalid taskKind/)
    const plain = createTask(db, { projectId: p.id, title: '默认工作' }, members.admin.id)
    expect(db.prepare('SELECT kind FROM tasks WHERE id = ?').get(plain.id).kind).toBe('work')
    // 机器人 add_task 提议生效链路（proposals.apply → createTask）透传任务分类（bot 协议字段名 taskKind）
    const viaProposal = PROPOSAL_KINDS.add_task.apply(db, {
      projectId: p.id, title: '提议建提醒', taskKind: 'reminder', planEndDate: today(),
    }, members.admin.id)
    expect(viaProposal.kind).toBe('reminder')
  })

  it('S57-6: 追踪口径只认 kind=work；个人视图（/my）与盘点保留提醒可见（⏰ 标注）', async () => {
    const p = seedProject('口径项目')
    // 模板任务清场（口径断言要精确基数；模板任务是 work 类，与被测排除逻辑无关）
    db.prepare(`UPDATE tasks SET deleted_at = ? WHERE project_id = ? AND deleted_at IS NULL`).run(Date.now(), p.id)
    // 1 条逾期工作（责任人=关键人王五）+ 2 条提醒（未来有主 / 过期未发无主）
    createTask(db, { projectId: p.id, title: '逾期工作', responsibleMemberId: members.key.id, planEndDate: addDays(today(), -1) }, members.admin.id)
    createTask(db, { projectId: p.id, title: '未来提醒', kind: 'reminder', responsibleMemberId: members.key.id, planEndDate: addDays(today(), 10) }, members.admin.id)
    createTask(db, { projectId: p.id, title: '过期提醒', kind: 'reminder', planEndDate: addDays(today(), -1) }, members.admin.id)

    // 逾期任务数/率：openTasks 分母与 overdue 分子均排除提醒
    const od = queryMetric(db, 'overdue_tasks', { groupBy: 'project' }).rows.find((x) => x.project === '口径项目')
    expect(od.overdue).toBe(1)
    expect(od.openTasks).toBe(1)
    // 健康分逾期子口径不计提醒（red 判定不被提醒污染）
    const health = queryMetric(db, 'project_health').rows.find((x) => x.project === '口径项目')
    expect(health.overdueTasks).toBe(1)
    // 关键人负载未完任务数排除提醒
    const load = queryMetric(db, 'keyperson_load', { groupBy: 'member' }).rows.find((x) => x.member === '王五')
    expect(load.openTasks).toBe(1)
    // 项目简报任务盘子与完成率排除提醒
    const brief = projectBrief(db, p.id)
    expect(brief.tasks.total).toBe(1)
    expect(brief.tasks.overdue).toBe(1)
    // 组合页任务进度排除提醒
    const projRow = listProjects(db).find((x) => x.id === p.id)
    expect(projRow.tasksTotal).toBe(1)
    // 未指派任务口径排除提醒（提醒无需分配）
    expect(queryMetric(db, 'unassigned_tasks', { groupBy: 'project' }).rows.find((x) => x.project === '口径项目')?.count ?? 0).toBe(0)
    // /my 个人视图保留提醒可见（含未来提醒）
    const mine = myWork(db, members.key.id)
    expect(mine.text).toContain('未来提醒')
    // 任务盘点保留提醒可见且带 ⏰ 标注
    const inv = tasksInventory(db, { projectId: p.id })
    expect(inv.text).toContain('⏰')
    expect(inv.text).toContain('过期提醒')
  })
})
