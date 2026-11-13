import { describe, it, expect, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setupDb, seedMembers } from './helpers.mjs'
import { openDb, migrate, MIGRATIONS_DIR } from '../db/index.mjs'
import { createProject } from '../engine/projects.js'
import { createTask, updateTask, tasksInventory, upsertChannel } from '../engine/tasks.js'
import { getDailyBoard, setDayStatus, isApplicableDay, cadenceLabel } from '../engine/dailyBoard.js'
import { dailyProjectMorningPush } from '../brain/morningPush.js'
import { PROPOSAL_KINDS } from '../engine/proposals.js'

// 唯一真相源直测：isApplicableDay 四档判定（含 2 月无 30/31 号、隔期周一）与 cadenceLabel 文案
describe('S75 周期纯函数', () => {
  it('isApplicableDay/cadenceLabel：四档判定与标签（2 月无 31 号不适用；隔期周一不适用）', () => {
    expect(isApplicableDay({ type: 'daily' }, '2026-02-01')).toBe(true)
    expect(isApplicableDay({ type: 'weekly', weekdays: [3] }, '2026-11-04')).toBe(true)
    expect(isApplicableDay({ type: 'weekly', weekdays: [3] }, '2026-11-03')).toBe(false)
    // biweekly parity 0（序列 A，周序号偶）：2026-11-02 所在周（148）适用；隔周 11-09（149）不适用；再下一周 11-16（150）又适用
    expect(isApplicableDay({ type: 'biweekly', weekdays: [1], parity: 0 }, '2026-11-02')).toBe(true)
    expect(isApplicableDay({ type: 'biweekly', weekdays: [1], parity: 0 }, '2026-11-09')).toBe(false)
    expect(isApplicableDay({ type: 'biweekly', weekdays: [1], parity: 0 }, '2026-11-16')).toBe(true)
    expect(isApplicableDay({ type: 'biweekly', weekdays: [1], parity: 1 }, '2026-11-09')).toBe(true)
    expect(isApplicableDay({ type: 'biweekly', weekdays: [1], parity: 1 }, '2026-11-16')).toBe(false)
    // monthly：日号命中；2027-02 无 30/31 号 → 不适用（cron 语义，不顺延）
    expect(isApplicableDay({ type: 'monthly', monthDays: [15, 31] }, '2026-12-31')).toBe(true)
    expect(isApplicableDay({ type: 'monthly', monthDays: [31] }, '2027-02-28')).toBe(false)
    expect(cadenceLabel({ type: 'monthly', monthDays: [1] })).toBe('每月1号')
    expect(cadenceLabel(null)).toBe('每天')
  })
})

// PRD S75（v0.87，K72）— 常态任务周期四档：tasks.cadence 统一对象（daily/weekly/biweekly/monthly），
// 适用判定唯一真相源 isApplicableDay；biweekly 复用 K65 纪元锚；monthly 当月无该日不适用（cron 语义）。
// 参考周（v0.87.3 修订：周序号 = floor(dayDiff(2024-01-01, day)/7)，parity = 周序号 % 2；纪元锚恰为周一）：
// 2026-11-02 所在周序号 148（parity 0=序列 A）、11-09 所在周 149（parity 1=序列 B）、
// 11-16 所在周 150（A）、11-23 所在周 151（B）——隔周严格交替。

let db
let members
let routine
afterAll(() => db?.close())

// 北京 2026-11-DD 上午 9 点的固定时刻（晨报/打卡的 now 注入，断言与真实运行日解耦）
const bjNov = (day) => Date.UTC(2026, 10, day, 1)

const applicableDays = (board, taskId) => {
  const row = board.tasks.find((t) => t.taskId === taskId)
  return row.cells.filter((c) => c.applicable).map((c) => c.day)
}

describe('S75 常态任务周期四档', () => {
  it('S75-1: cadence 四档归一与校验——daily 缺省；weekly/biweekly/monthly 参数合法；非法 400；legacy weekdays 兼容映射；交付任务拒绝', () => {
    ;({ db } = setupDb())
    members = seedMembers(db)
    routine = createProject(db, { name: '运营节奏', kind: 'routine', typeCode: 'routine_ops', leadMemberId: members.lead.id }, members.admin.id)
    db.prepare(`UPDATE tasks SET deleted_at = ? WHERE project_id = ?`).run(Date.now(), routine.id)

    const daily = createTask(db, { projectId: routine.id, title: '每日站会' }, members.admin.id)
    expect(daily.cadence).toEqual({ type: 'daily' })
    expect(daily.cadenceLabel).toBe('每天')
    expect(daily.weekdays).toEqual([1, 2, 3, 4, 5, 6, 7]) // 派生出参（兼容既有消费方）

    const weekly = createTask(db, { projectId: routine.id, title: '周一三五任务', cadence: { type: 'weekly', weekdays: [5, 1, 3] } }, members.admin.id)
    expect(weekly.cadence).toEqual({ type: 'weekly', weekdays: [1, 3, 5] })
    expect(weekly.cadenceLabel).toBe('每周一、三、五')
    expect(weekly.weekdays).toEqual([1, 3, 5])

    const biweek = createTask(db, { projectId: routine.id, title: '双周盘点', cadence: { type: 'biweekly', weekdays: [1], parity: 1 } }, members.admin.id)
    expect(biweek.cadence).toEqual({ type: 'biweekly', weekdays: [1], parity: 1 })
    expect(biweek.cadenceLabel).toBe('每两周周一')
    const biweekDefault = createTask(db, { projectId: routine.id, title: '双周盘点B', cadence: { type: 'biweekly', weekdays: [2, 4] } }, members.admin.id)
    expect(biweekDefault.cadence).toEqual({ type: 'biweekly', weekdays: [2, 4], parity: 0 }) // parity 缺省 0

    const monthly = createTask(db, { projectId: routine.id, title: '月度报表', cadence: { type: 'monthly', monthDays: [15, 1, 31] } }, members.admin.id)
    expect(monthly.cadence).toEqual({ type: 'monthly', monthDays: [1, 15, 31] })
    expect(monthly.cadenceLabel).toBe('每月1、15、31号')
    expect(monthly.weekdays).toBeNull()

    // 非法载荷 400
    const bad = [
      { type: 'hourly' },
      { type: 'weekly' },
      { type: 'weekly', weekdays: [] },
      { type: 'weekly', weekdays: [0] },
      { type: 'weekly', weekdays: [8] },
      { type: 'biweekly', weekdays: [1], parity: 2 },
      { type: 'biweekly', weekdays: [] },
      { type: 'monthly', monthDays: [] },
      { type: 'monthly', monthDays: [0] },
      { type: 'monthly', monthDays: [32] },
      'daily',
    ]
    for (const cadence of bad) {
      expect(() => createTask(db, { projectId: routine.id, title: '坏周期', cadence }, members.admin.id)).toThrow(/周期|cadence|weekdays|monthDays|档/)
    }

    // legacy weekdays 入参兼容：全周→daily、子集→weekly（bot/提议/立项模板路径零改动）
    const legacyDaily = createTask(db, { projectId: routine.id, title: '旧全周', weekdays: [1, 2, 3, 4, 5, 6, 7] }, members.admin.id)
    expect(legacyDaily.cadence).toEqual({ type: 'daily' })
    const legacyWeekly = createTask(db, { projectId: routine.id, title: '旧周三', weekdays: [3] }, members.admin.id)
    expect(legacyWeekly.cadence).toEqual({ type: 'weekly', weekdays: [3] })
    expect((updateTask(db, legacyWeekly.id, { weekdays: [2, 4] }, members.admin.id)).cadence).toEqual({ type: 'weekly', weekdays: [2, 4] })

    // 改周期：cadence patch 整档替换
    expect(updateTask(db, daily.id, { cadence: { type: 'monthly', monthDays: [1] } }, members.admin.id).cadence).toEqual({ type: 'monthly', monthDays: [1] })

    // 交付任务不带 cadence（同 S69 适用星期口径）
    const delivery = createProject(db, { name: '交付对照', typeCode: 'lianmai_365', leadMemberId: members.lead.id }, members.admin.id)
    expect(() => createTask(db, { projectId: delivery.id, title: '交付任务', cadence: { type: 'monthly', monthDays: [1] } }, members.admin.id)).toThrow(/周期|cadence|常态/)
  })

  it('S75-2: 执行视图 applicable 按 cadence 判定——monthly 仅日号命中；biweekly 仅 parity 匹配期；daily 全格；本期统计随算', () => {
    const monthly = createTask(db, { projectId: routine.id, title: '每月1/15号', cadence: { type: 'monthly', monthDays: [1, 15, 31] } }, members.admin.id).id
    const biweek0 = createTask(db, { projectId: routine.id, title: '每两周周一A', cadence: { type: 'biweekly', weekdays: [1], parity: 0 } }, members.admin.id).id

    // monthly：11 月无 31 号 → 1、15 两格；12 月有 31 号 → 三格（月窗口跨月各自判定）
    expect(applicableDays(getDailyBoard(db, routine.id, { anchor: '2026-11-01', span: 'month' }), monthly)).toEqual(['2026-11-01', '2026-11-15'])
    expect(applicableDays(getDailyBoard(db, routine.id, { anchor: '2026-12-01', span: 'month' }), monthly)).toEqual(['2026-12-01', '2026-12-15', '2026-12-31'])

    // biweekly parity 0：周窗口本序列周周一亮，隔周（序列 B 周）全灰
    expect(applicableDays(getDailyBoard(db, routine.id, { anchor: '2026-11-02', span: 'week' }), biweek0)).toEqual(['2026-11-02'])
    expect(applicableDays(getDailyBoard(db, routine.id, { anchor: '2026-11-16', span: 'week' }), biweek0)).toEqual(['2026-11-16'])
    // 双周窗口（K65 同锚）：窗内两序列交替可见——A 亮第一周周一、B 亮第二周周一（用户 2026-11-01 实证场景）
    const biweek1 = createTask(db, { projectId: routine.id, title: '每两周周一B', cadence: { type: 'biweekly', weekdays: [1], parity: 1 } }, members.admin.id).id
    expect(applicableDays(getDailyBoard(db, routine.id, { anchor: '2026-11-02', span: 'biweek' }), biweek0)).toEqual(['2026-11-02'])
    expect(applicableDays(getDailyBoard(db, routine.id, { anchor: '2026-11-02', span: 'biweek' }), biweek1)).toEqual(['2026-11-09'])
    expect(applicableDays(getDailyBoard(db, routine.id, { anchor: '2026-11-16', span: 'biweek' }), biweek0)).toEqual(['2026-11-16'])

    // daily：周窗口 7 格全亮
    const daily = createTask(db, { projectId: routine.id, title: '每天的事', cadence: { type: 'daily' } }, members.admin.id).id
    const dailyRow = getDailyBoard(db, routine.id, { anchor: '2026-11-02', span: 'week' }).tasks.find((t) => t.taskId === daily)
    expect(dailyRow.periodApplicable).toBe(7)
    expect(dailyRow.weekdaysLabel).toBe('每天')
    expect(dailyRow.cadenceLabel).toBe('每天')
  })

  it('S75-3: 打卡适用性——不适用日 400（monthly 无该日/biweekly 隔期/weekly 未勾）；适用日三档互转语义不变', () => {
    const monthly = createTask(db, { projectId: routine.id, title: '月检', cadence: { type: 'monthly', monthDays: [15] } }, members.admin.id)
    const biweek0 = createTask(db, { projectId: routine.id, title: '双周B', cadence: { type: 'biweekly', weekdays: [1], parity: 0 } }, members.admin.id)
    const weekly = createTask(db, { projectId: routine.id, title: '周三C', cadence: { type: 'weekly', weekdays: [3] } }, members.admin.id)
    const now = bjNov(15) // 固定「今天」=2026-11-15，断言与真实运行日解耦

    // 适用日可打：monthly 15 号、biweekly parity0 周一 11-02、weekly 周三 11-04
    expect(setDayStatus(db, { projectId: routine.id, taskId: monthly.id, day: '2026-11-15', status: 'done' }, members.admin.id, { now }).status).toBe('done')
    expect(setDayStatus(db, { projectId: routine.id, taskId: biweek0.id, day: '2026-11-02', status: 'skip' }, members.admin.id, { now }).status).toBe('skip')
    expect(setDayStatus(db, { projectId: routine.id, taskId: weekly.id, day: '2026-11-04', status: 'done' }, members.admin.id, { now }).status).toBe('done')
    // 三档互转（重置=删行）语义不变
    expect(setDayStatus(db, { projectId: routine.id, taskId: weekly.id, day: '2026-11-04', status: 'pending' }, members.admin.id, { now }).status).toBe('pending')

    // 不适用日拒绝（取过去日，避开未来日期守卫先行）：monthly 在 11-02 / biweekly parity0 在序列 B 周
    // 2026-10-26（周序号 147 → parity 1）/ weekly 在周二 11-03
    expect(() => setDayStatus(db, { projectId: routine.id, taskId: monthly.id, day: '2026-11-02', status: 'done' }, members.admin.id, { now })).toThrow(/不适用/)
    expect(() => setDayStatus(db, { projectId: routine.id, taskId: biweek0.id, day: '2026-10-26', status: 'done' }, members.admin.id, { now })).toThrow(/不适用/)
    expect(() => setDayStatus(db, { projectId: routine.id, taskId: weekly.id, day: '2026-11-03', status: 'done' }, members.admin.id, { now })).toThrow(/不适用/)
  })

  it('S75-4: 晨报今日/明日待办按 isApplicableDay——monthly 当日号命中才列；biweekly 隔期不列；weekly/daily 照常', async () => {
    const p = createProject(db, { name: '晨报节奏', kind: 'routine', typeCode: 'lianmai_365', leadMemberId: members.lead.id }, members.admin.id)
    db.prepare(`UPDATE tasks SET deleted_at = ? WHERE project_id = ?`).run(Date.now(), p.id)
    upsertChannel(db, { platform: 'feishu', groupKey: `oc_s75_${p.id}`, channelType: 'dedicated', projectId: p.id })
    createTask(db, { projectId: p.id, title: '月度结算单', cadence: { type: 'monthly', monthDays: [15] } }, members.admin.id)
    createTask(db, { projectId: p.id, title: '双周对账A', cadence: { type: 'biweekly', weekdays: [1], parity: 0 } }, members.admin.id)
    createTask(db, { projectId: p.id, title: '周三例会C', cadence: { type: 'weekly', weekdays: [3] } }, members.admin.id)
    createTask(db, { projectId: p.id, title: '每日巡检D' }, members.admin.id)

    const sent = []
    // v0.91 附带修复（日期炸弹）：晨报幂等行 created_at 是真实时刻，注入时刻向前倒跳（15→9 号）时
    // 真实 created_at ≥ 注入日起点会被误判「今日已推」——原测试只在真实日期早于 2026-11-09 时成立。
    // 每次推送前清该项目晨报台账行，断言聚焦 isApplicableDay 口径本身（幂等守卫由 S68 用例覆盖）。
    const clearMorningLedger = () => db.prepare(`DELETE FROM pushes WHERE push_type = 'morning' AND related_project_id = ?`).run(p.id)
    clearMorningLedger()
    await dailyProjectMorningPush(db, { now: () => bjNov(15), send: async (m) => { sent.push(m); return { messageId: 'om_1' } } }) // 2026-11-15 周日
    const day1Full = (sent.at(-1).post ? (sent.at(-1).post.zh_cn?.content || []).flat().map((r) => r?.text || '').join('\n') : sent.at(-1).text)
    const [day1, day1Tomorrow] = day1Full.split('【明日待办】') // 段落拆开：今日/明日分别断言（明日预览会带出命中任务）
    expect(day1).toContain('月度结算单') // monthly 命中 15 号
    expect(day1).toContain('每日巡检D') // daily
    expect(day1).not.toContain('双周对账A') // 周日不适用（biweekly 只认周一）
    expect(day1).not.toContain('周三例会C') // 周日不适用（weekly 只认周三）
    expect(day1Tomorrow).toContain('双周对账A') // 明日 11-16 周一命中序列 A 周（v0.87.3 隔周，明日预览如实带出）

    const sent2 = []
    clearMorningLedger()
    await dailyProjectMorningPush(db, { now: () => bjNov(9), send: async (m) => { sent2.push(m); return { messageId: 'om_2' } } }) // 2026-11-09 周一（周序号 149 → 序列 B 周）
    const day2Full = (sent2.at(-1).post ? (sent2.at(-1).post.zh_cn?.content || []).flat().map((r) => r?.text || '').join('\n') : sent2.at(-1).text)
    // 断言只看今日/明日待办段：【昨日以来动态】以注入时钟开窗、事件 created_at 是真实时刻，
    // 真实日期越过固定注入日后动态段会合法带出任务名，不得参与适用性断言（v0.91 附带修复）
    const [day2Today, day2Tomorrow] = day2Full.split('【明日待办】')
    expect(day2Today).not.toContain('月度结算单') // 9 号非 15 号
    expect(day2Today).not.toContain('双周对账A') // 周一但序列 B 周（周序号 149 奇）——S75 核心口径（v0.87.3 隔周）
    expect(day2Today).not.toContain('周三例会C') // 周一非周三
    expect(day2Today).toContain('每日巡检D')
    // 明日预览（11-10 周二）：仅 daily（再切掉昨日动态段——见上方注）
    const day2TomorrowOnly = day2Tomorrow.split('【昨日以来动态】')[0]
    expect(day2TomorrowOnly).not.toContain('双周对账A')

    const sent3 = []
    clearMorningLedger()
    await dailyProjectMorningPush(db, { now: () => bjNov(16), send: async (m) => { sent3.push(m); return { messageId: 'om_3' } } }) // 2026-11-16 周一（周序号 150 → 序列 A 周，隔周回归）
    const day3Full = (sent3.at(-1).post ? (sent3.at(-1).post.zh_cn?.content || []).flat().map((r) => r?.text || '').join('\n') : sent3.at(-1).text)
    const [day3Today] = day3Full.split('【明日待办】')
    expect(day3Today).toContain('双周对账A') // 周一且序列 A 周命中——隔周严格交替（v0.87.3）
    expect(day3Today).toContain('每日巡检D')
  })

  it('S75-5: 迁移 0038 回填——weekdays 全周/NULL→daily、子集→weekly；weekdays 列删除；出参 weekdays 为派生', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-pmo-mig-'))
    const raw = openDb(path.join(dir, 'pre0038.db'))
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql') && f < '0038_task_cadence.sql').sort()
    raw.exec(`CREATE TABLE IF NOT EXISTS migrations_meta (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`)
    for (const f of files) {
      raw.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'))
      raw.prepare(`INSERT INTO migrations_meta (name, applied_at) VALUES (?, 0)`).run(f)
    }
    // 旧库常态项目 + 三条老形态任务（weekdays 全周 / 子集 / NULL）
    raw.prepare(`INSERT INTO members (name, username, role, status, created_at, updated_at) VALUES ('甲','mig','admin','active',0,0)`).run()
    raw.prepare(`INSERT INTO projects (name, status, priority, kind, lead_member_id, created_at, updated_at) VALUES ('旧库常态','active','medium','routine',1,0,0)`).run()
    const ins = raw.prepare(`INSERT INTO tasks (project_id, title, status, kind, weekdays, source, created_at, updated_at) VALUES (1, ?, 'todo', 'routine', ?, 'manual', 0, 0)`)
    ins.run('全周任务', '1,2,3,4,5,6,7')
    ins.run('周一三五任务', '1,3,5')
    ins.run('空星期任务', null)

    expect(migrate(raw)).toBe(2) // 应用 0038 + 0039（v0.91 游标归一迁移；0039 对无渠道旧库为空更新）
    const rows = raw.prepare(`SELECT title, cadence FROM tasks ORDER BY id`).all()
    expect(JSON.parse(rows[0].cadence)).toEqual({ type: 'daily' })
    expect(JSON.parse(rows[1].cadence)).toEqual({ type: 'weekly', weekdays: [1, 3, 5] })
    expect(JSON.parse(rows[2].cadence)).toEqual({ type: 'daily' }) // NULL 视为缺省每天（S69 缺省口径）
    expect(raw.prepare(`SELECT COUNT(*) AS n FROM pragma_table_info('tasks') WHERE name = 'weekdays'`).get().n).toBe(0) // 列已删
    raw.close()
  })

  it('S75-6: 盘点与 bot 通道——cadenceLabel 呈现；add_task 提议 weekdays 载荷兼容映射 weekly', () => {
    const inv = tasksInventory(db, { projectId: routine.id })
    expect(inv.text).toContain('每月1、15、31号')
    expect(inv.text).toContain('每两周周一')

    // bot add_task 提议生效链路（proposals.apply → createTask）携带 legacy weekdays → weekly cadence
    const viaProposal = PROPOSAL_KINDS.add_task.apply(db, { projectId: routine.id, title: '群内加的双周四', weekdays: [2, 4] }, members.admin.id)
    expect(viaProposal.cadence).toEqual({ type: 'weekly', weekdays: [2, 4] })
    expect(viaProposal.cadenceLabel).toBe('每周二、四')
  })
})
