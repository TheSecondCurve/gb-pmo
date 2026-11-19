// PRD S66 — 我的任务工作台：跨在跑项目聚合本人未完任务（/my 同口径），按项目分组 + 统计。
import { describe, it, expect, afterAll } from 'vitest'
import { setupApp, loginCookie, authed } from './helpers.mjs'
import { createProject, cancelProject } from '../engine/projects.js'
import { createTask, updateTask, deleteTask } from '../engine/tasks.js'
import { setDayStatus } from '../engine/dailyBoard.js'
import { addEvent } from '../engine/events.js'
import { myTasksBoard } from '../engine/statusBoard.js'
import { today, addDays, bjWeekStartMs, weekdayOf } from '../db/time.js'

// 造数（各用例共用一份库）：dev 名下 A 项目 4 条（区间/逾期/今天到期/上周到期）+ B 项目 2 条（纯提醒/未排期），
// 另有他人任务、已完成、软删、终态项目任务各 1 条（均不应出现在 dev 视图）。
let ctx
let s
afterAll(() => ctx?.db.close())

const day = (n) => addDays(today(), n)

async function seed() {
  ctx = await setupApp()
  const { lead, dev } = ctx.members
  const a = createProject(ctx.db, { name: '客户A系统', templateCode: 'lianmai_365', leadMemberId: lead.id }, 1)
  const b = createProject(ctx.db, { name: '客户B小程序', templateCode: 'lianmai_365', leadMemberId: lead.id }, 1)
  const c = createProject(ctx.db, { name: '已取消项目', templateCode: 'lianmai_365', leadMemberId: lead.id }, 1)
  const t = (projectId, input) => createTask(ctx.db, { projectId, ...input }, 1)
  s = {
    a, b, c,
    dated: t(a.id, { title: '联调接口', responsibleMemberId: dev.id, planStartDate: day(-3), planEndDate: day(5) }),
    overdue: t(a.id, { title: '逾期未完的活', responsibleMemberId: dev.id, planEndDate: day(-4) }),
    dueToday: t(a.id, { title: '今天到期', responsibleMemberId: dev.id, planEndDate: day(0) }),
    lastWeek: t(a.id, { title: '上周到期', responsibleMemberId: dev.id, planEndDate: day(-8) }),
    others: t(a.id, { title: '别人的任务', responsibleMemberId: lead.id, planEndDate: day(5) }),
    done: t(a.id, { title: '已完成的活', responsibleMemberId: dev.id }),
    removed: t(a.id, { title: '已删的活', responsibleMemberId: dev.id, planEndDate: day(5) }),
    reminder: t(b.id, { title: '给客户发周报', responsibleMemberId: dev.id, kind: 'reminder', planEndDate: day(1) }),
    undated: t(b.id, { title: '还没排期', responsibleMemberId: dev.id }),
    gone: t(c.id, { title: '终态项目里的任务', responsibleMemberId: dev.id, planEndDate: day(5) }),
  }
  updateTask(ctx.db, s.done.id, { status: 'done' }, 1)
  deleteTask(ctx.db, s.removed.id, 1)
  cancelProject(ctx.db, c.id, { reason: '不做了' }, 1)
}

describe('S66 我的任务工作台', () => {
  it('S66-1: 跨在跑项目聚合本人未完任务、按项目分组；排除他人/已完成/软删/终态项目；纯提醒 ⏰ 标注', async () => {
    await seed()
    const board = myTasksBoard(ctx.db, ctx.members.dev.id)
    expect(board.projects).toHaveLength(2)
    const ga = board.projects.find((p) => p.projectName === '客户A系统')
    const gb = board.projects.find((p) => p.projectName === '客户B小程序')
    expect(ga.tasks.map((x) => x.title).sort()).toEqual(['上周到期', '今天到期', '联调接口', '逾期未完的活'])
    expect(gb.tasks.map((x) => x.title).sort()).toEqual(['给客户发周报', '还没排期'])
    const all = board.projects.flatMap((p) => p.tasks)
    for (const excluded of ['别人的任务', '已完成的活', '已删的活', '终态项目里的任务']) {
      expect(all.map((x) => x.title)).not.toContain(excluded)
    }
    // 纯提醒标注（S57 口径：/my 与盘点仍可见提醒）
    expect(gb.tasks.find((x) => x.title === '给客户发周报').isReminder).toBe(true)
    expect(ga.tasks.every((x) => !x.isReminder)).toBe(true)
  })

  it('S66-2: 统计口径——逾期按北京日、本周到期按北京自然周且不早于今日（逾期不重复计入本周）', async () => {
    // 一条待确认建议指向 dev 的任务（S55 口径：责任人是确认对象之一）
    addEvent(ctx.db, {
      projectId: s.a.id, nature: 'suggestion', eventType: 'status_change', summary: '联调接口完成了？',
      targetTaskId: s.dated.id, targetField: 'status', targetValue: 'done', generatedBy: 'extraction',
    })
    const board = myTasksBoard(ctx.db, ctx.members.dev.id)
    const { total, overdue, dueThisWeek, pending } = board.stats
    expect(total).toBe(6) // A:4 + B:2
    expect(overdue).toBe(2) // day(-4) 与 day(-8)
    // 本周到期 = 到期日落在 [今天, 本周日] 窗内：夹具里 dev 的候选是 day(0)/day(1)/day(5)，哪些落窗取决于跑测星期几
    // （周日跑 day(1) 落下周；周一/周二跑 day(5) 还在本周），按同一北京自然周口径从夹具精确推算，不再靠区间兜底
    const sunday = addDays(today(bjWeekStartMs(Date.now())), 6)
    const expectedThisWeek = [day(0), day(1), day(5)].filter((d) => d <= sunday).length
    expect(dueThisWeek).toBe(expectedThisWeek)
    expect(pending).toBe(1)
    // 逾期天数：day(-4) → 4 天；今天口径随数据返回（前端今日线对齐用）
    const od = board.projects.flatMap((p) => p.tasks).find((x) => x.title === '逾期未完的活')
    expect(od.overdueDays).toBe(4)
    expect(board.today).toBe(today())
  })

  it('S66-1: 路由——GET /api/v1/my-tasks 按会话成员定域；未登录 401；他人视角隔离', async () => {
    const anon = await ctx.app.inject({ method: 'GET', url: '/api/v1/my-tasks' })
    expect(anon.statusCode).toBe(401)

    const devCookie = await loginCookie(ctx.app, 'lisi', 'pass-123456')
    const dev = await authed(ctx.app, devCookie, 'GET', '/api/v1/my-tasks')
    expect(dev.status).toBe(200)
    expect(dev.body.stats.total).toBe(6)
    expect(dev.body.projects).toHaveLength(2)
    expect(dev.body.projects[0].tasks[0].projectId).toBeTruthy()

    const leadCookie = await loginCookie(ctx.app, 'zhangsan', 'pass-123456')
    const leadView = await authed(ctx.app, leadCookie, 'GET', '/api/v1/my-tasks')
    expect(leadView.status).toBe(200)
    expect(leadView.body.projects.flatMap((p) => p.tasks.map((x) => x.title))).toEqual(['别人的任务'])
  })

  it('S66-5: 今日常态任务区——仅当日 cadence 适用（历史/非今日不出现）、含今日状态三档、未做→跳过→完成排序；不进统计、按成员定域', async () => {
    const { dev, lead } = ctx.members
    const wd = weekdayOf(today())
    const otherWd = wd === 2 ? 3 : 2 // 必然 ≠ 今天的星期（今天不适用）
    const r = createProject(ctx.db, {
      name: '常态运营', kind: 'routine', typeCode: 'routine_ops', leadMemberId: lead.id,
      tasks: [
        '每日盘点',
        { title: '今天才有的周任务', weekdays: [wd] },
        { title: '非今天的周任务', weekdays: [otherWd] },
        '已完成的常态活',
        '已跳过的常态活',
        '别人的常态活',
      ],
    }, 1)
    for (const id of [r.tasks[0].id, r.tasks[1].id, r.tasks[2].id, r.tasks[3].id, r.tasks[4].id]) {
      updateTask(ctx.db, id, { responsibleMemberId: dev.id }, 1)
    }
    updateTask(ctx.db, r.tasks[5].id, { responsibleMemberId: lead.id }, 1)
    setDayStatus(ctx.db, { projectId: r.id, taskId: r.tasks[3].id, day: today(), status: 'done' }, dev.id)
    setDayStatus(ctx.db, { projectId: r.id, taskId: r.tasks[4].id, day: today(), status: 'skip' }, dev.id)

    const board = myTasksBoard(ctx.db, dev.id)
    expect(board.routine).toHaveLength(1)
    const g = board.routine[0]
    expect(g.projectId).toBe(r.id)
    expect(g.projectName).toBe('常态运营')
    // 非今日适用不出现；档序 未做→跳过→完成，同档保持任务序
    expect(g.tasks.map((t) => t.title)).toEqual(['每日盘点', '今天才有的周任务', '已跳过的常态活', '已完成的常态活'])
    expect(g.tasks.map((t) => t.status)).toEqual(['pending', 'pending', 'skip', 'done'])
    expect(g.tasks[0].cadenceLabel).toBe('每天')
    expect(g.tasks[1].cadenceLabel).toMatch(/^每周/)
    // 未完任务口径不变（S69-6 主体）：统计与 projects[] 均不含常态任务
    expect(board.stats.total).toBe(6)
    expect(JSON.stringify(board.projects)).not.toContain('每日盘点')
    // 成员定域：别人的常态活不进 dev 视图；dev 的常态任务在 lead 视图只有他自己的
    expect(JSON.stringify(board.routine)).not.toContain('别人的常态活')
    const leadBoard = myTasksBoard(ctx.db, lead.id)
    expect(leadBoard.routine.flatMap((x) => x.tasks.map((t) => t.title))).toEqual(['别人的常态活'])

    // 路由：GET /api/v1/my-tasks 响应带 routine 区（按会话成员定域）
    const cookie = await loginCookie(ctx.app, 'lisi', 'pass-123456')
    const res = await authed(ctx.app, cookie, 'GET', '/api/v1/my-tasks')
    expect(res.status).toBe(200)
    expect(res.body.routine[0].projectName).toBe('常态运营')
  })
})
