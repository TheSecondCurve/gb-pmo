import { describe, it, expect, afterAll } from 'vitest'
import { setupDb, seedMembers } from './helpers.mjs'
import { createProject } from '../engine/projects.js'
import { setSetting } from '../engine/settings.js'
import { weeklyBrief } from '../engine/weekly.js'
import { weeklyDigestRun } from '../brain/digest.js'
import { dueTasks, initialLastRun } from '../brain/scheduler.js'
import { getSetting } from '../engine/settings.js'
import { today, addDays, bjWeekStartMs } from '../db/time.js'

// PRD S49（v0.54，K32）— 每周定时梳理接线 + 老板周报简报

let db
afterAll(() => db?.close())

describe('S49 每周定时梳理与老板周报', () => {
  it('S49-1: digest 任务进调度器（cron 校验 400 / enabled 开关停跑 / 配置台默认值齐备）', async () => {
    ;({ db } = setupDb())
    // 默认值存在且合法
    const sched = getSetting(db, 'scheduler')
    expect(sched.digestCron).toBe('0 9 * * 1')
    expect(sched.digestEnabled).toBe(true)
    // 非法 cron 400
    expect(() => setSetting(db, 'scheduler', { digestCron: 'not-a-cron' })).toThrowError(/cron/i)
    // 开关停跑：dueTasks 不含 digest
    const now = Date.now()
    const due = dueTasks({ ...sched, digestCron: '* * * * *', digestEnabled: false }, {}, now)
    expect(due).not.toContain('digest')
    const due2 = dueTasks({ ...sched, digestCron: '* * * * *', digestEnabled: true }, {}, now)
    expect(due2).toContain('digest')
    // 冷启动锚点：digest 锚定当日零点（周一跨过 cron 时点的重启可补跑，由 runner 判重兜底）
    expect(initialLastRun(db, 'digest', now)).toBeLessThanOrEqual(now)
  })

  it('S49-2: 到点触发 → 在跑项目逐个梳理推牵头人；周报推管理员（新增/结项/逾期/沉默/交付临近/过载齐备）；LLM 综述可选', async () => {
    ;({ db } = setupDb())
    const members = seedMembers(db)
    // 在跑项目 A：牵头人张三，任务逾期
    const a = createProject(db, { name: 'A系统交付', typeCode: 'lianmai_365', leadMemberId: members.lead.id, planEndDate: addDays(today(), 10) }, members.admin.id)
    db.prepare('UPDATE tasks SET responsible_member_id = ?, plan_end_date = ? WHERE id = ?')
      .run(members.dev.id, addDays(today(), -2), a.tasks[0].id)
    // 在跑项目 B：沉默（事件与任务更新压到 10 天前）
    const b = createProject(db, { name: 'B停滞项目', typeCode: 'lianmai_365', leadMemberId: members.dev.id }, members.admin.id)
    const old = Date.now() - 10 * 86400000
    db.prepare('UPDATE project_events SET business_time = ? WHERE project_id = ?').run(old, b.id)
    db.prepare('UPDATE tasks SET updated_at = ? WHERE project_id = ?').run(old, b.id)

    // 确定性数据组装（零 LLM）
    const brief = weeklyBrief(db)
    expect(brief.weekStart).toBe(today(bjWeekStartMs()))
    expect(brief.started.map((p) => p.name)).toContain('A系统交付') // 本周新增
    expect(brief.overdue.find((p) => p.name === 'A系统交付').overdueCount).toBe(1)
    expect(brief.silent.map((p) => p.name)).toContain('B停滞项目')
    expect(brief.upcoming.map((p) => p.name)).toContain('A系统交付') // 10 天后交付
    expect(brief.text).toContain('A系统交付')
    expect(brief.text).toContain('B停滞项目')

    // 整轮跑：无 LLM（降级纯数据）+ fake 投递
    const calls = []
    const fakeSend = async (m) => { calls.push(m); return { messageId: 'om_w' } }
    const out = await weeklyDigestRun(db, { send: fakeSend })
    expect(out.skipped).toBeFalsy()
    expect(out.digests).toBe(2) // 两个在跑项目都跑了项目梳理
    // 牵头人收到项目梳理（digest 推送）
    const digestPushes = db.prepare(`SELECT * FROM pushes WHERE push_type = 'digest' AND title LIKE '项目梳理%'`).all()
    expect(digestPushes.length).toBe(2)
    // 管理员收到周报
    const briefPush = db.prepare(`SELECT * FROM pushes WHERE push_type = 'digest' AND title LIKE '项目大脑周报%'`).get()
    expect(briefPush).toBeTruthy()
    expect(briefPush.body).toContain('A系统交付')
    expect(briefPush.body).toContain('本周新增')
    expect(briefPush.body).toContain('沉默')

    // LLM 配置时附加综述段（fake 适配器）
    const fake = { name: 'fake', complete: async () => '本周重点关注 A系统交付：逾期与交付临近并存。' }
    db.prepare(`DELETE FROM pushes`).run() // 清掉上轮，解除周级判重
    const out2 = await weeklyDigestRun(db, { llm: fake, send: fakeSend })
    const briefPush2 = db.prepare(`SELECT * FROM pushes WHERE title LIKE '项目大脑周报%' ORDER BY id DESC`).get()
    expect(briefPush2.body).toContain('本周重点关注') // 综述段
    expect(out2.brief.overdue.length).toBe(1)
  })

  it('S49-3: 同一自然周内重复触发 → 整轮跳过（不重复产梳理与周报推送）', async () => {
    const before = db.prepare(`SELECT COUNT(*) AS n FROM pushes`).get().n
    const out = await weeklyDigestRun(db, {})
    expect(out.skipped).toBe(true)
    const after = db.prepare(`SELECT COUNT(*) AS n FROM pushes`).get().n
    expect(after).toBe(before)
    // 项目事件也不新增（建议事件不重复制造）
    expect(db.prepare(`SELECT COUNT(*) AS n FROM project_events WHERE generated_by = 'digest'`).get().n).toBe(0)
  })
})
