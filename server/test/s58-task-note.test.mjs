import { describe, it, expect, afterAll } from 'vitest'
import { setupDb, seedMembers } from './helpers.mjs'
import { createProject } from '../engine/projects.js'
import { createProjectType, getProjectType, MAX_TASK_NOTE } from '../engine/projectTypes.js'
import { createTask, updateTask, getTask, listTasks, overdueTasksOf, upsertChannel } from '../engine/tasks.js'
import { PROPOSAL_KINDS } from '../engine/proposals.js'
import { evaluateReminders } from '../brain/reminder.js'
import { evaluateAlerts } from '../brain/alert.js'
import { buildReminderCard, buildOverdueAlertCard } from '../brain/bot/cards.js'
import { personDigest } from '../brain/digest.js'
import { dailyReport } from '../brain/report.js'
import { today, addDays, bjDayStartMs } from '../db/time.js'

// PRD S58（v0.64，K42）— 任务备注域：模板（项目类型内嵌清单）默认备注立项拷贝、实例独立改、
// 纯提醒/逾期预警/个人梳理/晨报推送携带备注；≤200 字引擎校验、卡片渲染截断。

let db
let members
afterAll(() => db?.close())

const atHour = (h) => () => bjDayStartMs(Date.now()) + h * 3_600_000

function fakeSend(sink) {
  return async (payload) => {
    sink.push(payload)
    return { messageId: `om_${sink.length}` }
  }
}

const seedProject = (name, extra = {}) =>
  createProject(db, { name, typeCode: 'lianmai_365', leadMemberId: members.lead.id, ...extra }, members.admin.id)

describe('S58 任务备注域', () => {
  it('S58-1: 创建/更新带备注并回读；空串归一 NULL；超长 400；变更落 task.update 审计', () => {
    ;({ db } = setupDb())
    members = seedMembers(db)
    const p = seedProject('备注主项目')
    const t = createTask(db, { projectId: p.id, title: '执行交付', note: '带验收清单，照 SOP 第三节执行' }, members.admin.id)
    expect(getTask(db, t.id).note).toBe('带验收清单，照 SOP 第三节执行')
    expect(listTasks(db, { projectId: p.id }).find((x) => x.id === t.id).note).toBe('带验收清单，照 SOP 第三节执行')

    updateTask(db, t.id, { note: '改口径：以客户确认邮件为准' }, members.admin.id)
    expect(getTask(db, t.id).note).toBe('改口径：以客户确认邮件为准')
    expect(db.prepare(`SELECT 1 FROM audit_logs WHERE action = 'task.update' AND object_id = ? AND detail LIKE '%note%'`).get(String(t.id))).toBeTruthy()

    updateTask(db, t.id, { note: '' }, members.admin.id)
    expect(getTask(db, t.id).note).toBeNull()

    const long = '长'.repeat(MAX_TASK_NOTE + 1)
    expect(() => createTask(db, { projectId: p.id, title: '超长备注', note: long }, members.admin.id)).toThrow(/不超过 200 字/)
    expect(() => updateTask(db, t.id, { note: long }, members.admin.id)).toThrow(/不超过 200 字/)
  })

  it('S58-2: 类型默认备注随清单保存读取；立项模板路径拷贝、自定义清单未给为空；实例改不回写类型', () => {
    const type = createProjectType(db, {
      code: 's58', name: '备注类型',
      tasks: [{ title: '方案评审', note: '会前发材料，会后 24h 出纪要' }, '现场布置'],
    }, members.admin.id)
    const back = getProjectType(db, type.id)
    expect(back.tasks[0].note).toBe('会前发材料，会后 24h 出纪要')
    expect(back.tasks[1].note).toBeNull()

    // 模板路径立项：默认备注随任务拷贝进实例
    const p1 = createProject(db, { name: '模板立项', typeCode: 's58', leadMemberId: members.lead.id }, members.admin.id)
    const t1 = listTasks(db, { projectId: p1.id }).find((x) => x.title === '方案评审')
    expect(t1.note).toBe('会前发材料，会后 24h 出纪要')

    // 自定义清单（S1-6）：字符串项无备注（编辑清单=放弃类型默认）；显式给则携带
    const p2 = createProject(db, {
      name: '自定义立项', typeCode: 's58', leadMemberId: members.lead.id,
      tasks: ['方案评审', { title: '现场布置', note: '自定义备注生效' }],
    }, members.admin.id)
    expect(listTasks(db, { projectId: p2.id }).find((x) => x.title === '方案评审').note).toBeNull()
    expect(listTasks(db, { projectId: p2.id }).find((x) => x.title === '现场布置').note).toBe('自定义备注生效')

    // 实例独立改，不回写类型（类型只影响未来立项，v0.18 口径）
    updateTask(db, t1.id, { note: '实例自有备注' }, members.admin.id)
    expect(getProjectType(db, type.id).tasks[0].note).toBe('会前发材料，会后 24h 出纪要')
  })

  it('S58-3: 纯提醒推送携带备注（卡片+正文），无备注不带空行；超长备注卡片渲染截断', async () => {
    const p = seedProject('提醒备注项目')
    upsertChannel(db, { platform: 'feishu', groupKey: 'oc_s58', channelType: 'dedicated', projectId: p.id })
    createTask(db, {
      projectId: p.id, title: '评审会提醒', kind: 'reminder',
      responsibleMemberId: members.dev.id, planEndDate: today(), note: '3 号会议室，带投影',
    }, members.admin.id)
    createTask(db, { projectId: p.id, title: '无备注提醒', kind: 'reminder', planEndDate: today() }, members.admin.id)

    const sent = []
    const { reminders } = await evaluateReminders(db, { send: fakeSend(sent), now: atHour(10) })
    expect(reminders.length).toBe(2)
    // 卡片带备注（责任人私聊）
    const priv = sent.find((s) => s.openId === members.dev.feishuId)
    expect(JSON.stringify(priv?.card)).toContain('3 号会议室，带投影')
    // 正文带备注（pushes 落库，卡片降级与 web 收件箱共用）
    const row = db.prepare(`SELECT body FROM pushes WHERE push_type = 'reminder' AND title LIKE '%评审会提醒%' AND recipient_member_id = ?`).get(members.dev.id)
    expect(row.body).toContain('备注：3 号会议室，带投影')
    // 无备注任务不带「备注：」空行
    const bare = db.prepare(`SELECT body FROM pushes WHERE push_type = 'reminder' AND title LIKE '%无备注提醒%' LIMIT 1`).get()
    expect(bare.body).not.toContain('备注：')

    // 超长备注卡片渲染截断（防御：入库前已有引擎校验，此处护栏历史/手工数据）
    const c = buildReminderCard({ title: '截断', projectName: 'P', planEndDate: today(), note: '长'.repeat(MAX_TASK_NOTE + 100) })
    const s = JSON.stringify(c)
    expect(s.includes('长'.repeat(MAX_TASK_NOTE + 1))).toBe(false)
    expect(s).toContain('…')
  })

  it('S58-4: 逾期预警携带备注（overdueTasksOf 带出、文本与卡片渲染），卡片超长截断', async () => {
    const p = seedProject('逾期备注项目')
    createTask(db, {
      projectId: p.id, title: '逾期交付', responsibleMemberId: members.dev.id,
      planEndDate: addDays(today(), -3), note: '先发里程碑确认函补救',
    }, members.admin.id)
    expect(overdueTasksOf(db, members.dev.id).find((x) => x.title === '逾期交付').note).toBe('先发里程碑确认函补救')

    const sent = []
    await evaluateAlerts(db, { send: fakeSend(sent) })
    const priv = sent.find((s) => s.openId === members.dev.feishuId)
    expect(priv?.card).toBeTruthy()
    expect(JSON.stringify(priv.card)).toContain('先发里程碑确认函')
    const row = db.prepare(`SELECT body FROM pushes WHERE push_type = 'alert' AND title LIKE '%逾期任务预警%' AND recipient_member_id = ?`).get(members.dev.id)
    expect(row.body).toContain('备注：先发里程碑确认函')

    const c = buildOverdueAlertCard({
      memberName: '李四',
      tasks: [{ id: 1, title: '甲', projectName: 'P', planEndDate: today(), daysOverdue: 2, note: 'x'.repeat(MAX_TASK_NOTE + 50) }],
    })
    expect(JSON.stringify(c).includes('x'.repeat(MAX_TASK_NOTE + 1))).toBe(false)
  })

  it('S58-5: 个人梳理与晨报任务清单附带备注（与参考资料随推送同管道语义）', async () => {
    // 复用上一用例：dev 名下未完任务「逾期交付」带备注
    await personDigest(db, members.dev.id, { llm: null })
    const drow = db.prepare(`SELECT body FROM pushes WHERE push_type = 'digest' AND recipient_member_id = ?`).get(members.dev.id)
    expect(drow.body).toContain('备注：先发里程碑确认函')

    await dailyReport(db, { force: true })
    const rrow = db.prepare(`SELECT body FROM pushes WHERE push_type = 'daily_report' AND recipient_member_id = ?`).get(members.dev.id)
    expect(rrow.body).toContain('【任务备注】')
    expect(rrow.body).toContain('- 逾期交付：先发里程碑确认函补救')
  })

  it('S58-6: 机器人/web AI 助手 add_task 提议生效透传备注（缺省无备注）', () => {
    const p = db.prepare(`SELECT id FROM projects WHERE name = '备注主项目'`).get()
    const withNote = PROPOSAL_KINDS.add_task.apply(db, {
      projectId: p.id, title: '提议带备注', note: '机器人建的，备注带上',
    }, members.admin.id)
    expect(withNote.note).toBe('机器人建的，备注带上')
    const noNote = PROPOSAL_KINDS.add_task.apply(db, { projectId: p.id, title: '提议无备注' }, members.admin.id)
    expect(noNote.note).toBeNull()
  })
})
