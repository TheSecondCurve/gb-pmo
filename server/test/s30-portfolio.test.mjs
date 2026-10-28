import { describe, it, expect, afterAll } from 'vitest'
import { setupApp, loginCookie, authed } from './helpers.mjs'
import { today, addDays } from '../db/time.js'

// PRD S30-1（v0.29）— 项目组合页数据契约：列表接口状态过滤 + 四个月期字段。
// 两者均为既有能力（SELECT p.* / ?status= 参数），组合页纯前端消费，此处补契约锚定防回归。
// S30-7（v0.79，K62）— 服务端查询化：q 模糊 / priority / sort / unscheduled·overdue / page·pageSize / total·facets。

let ctx
afterAll(() => ctx?.db.close())

describe('S30 项目组合页数据契约', () => {
  it('S30-1: ?status=active,closed,cancelled 返回全部三态项目且行含四个月期字段；缺省仅进行中', async () => {
    ctx = await setupApp()
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const base = { templateCode: 'lianmai_365', leadMemberId: ctx.members.lead.id, tasks: [] }

    const a = await authed(ctx.app, cookie, 'POST', '/api/v1/projects', { ...base, name: '在跑甲' })
    expect(a.status).toBe(201)

    const b = await authed(ctx.app, cookie, 'POST', '/api/v1/projects', {
      ...base, name: '结项乙', planStartDate: '2026-08-01', planEndDate: '2026-08-31',
    })
    expect(b.status).toBe(201)
    const close = await authed(ctx.app, cookie, 'POST', `/api/v1/projects/${b.body.id}/close`, { summary: '交付完成' })
    expect(close.status).toBe(200)

    const c = await authed(ctx.app, cookie, 'POST', '/api/v1/projects', { ...base, name: '取消丙' })
    expect(c.status).toBe(201)
    const cancel = await authed(ctx.app, cookie, 'POST', `/api/v1/projects/${c.body.id}/cancel`, { reason: '战略调整' })
    expect(cancel.status).toBe(200)

    const all = await authed(ctx.app, cookie, 'GET', '/api/v1/projects?status=active,closed,cancelled')
    expect(all.status).toBe(200)
    const names = all.body.projects.map((p) => p.name)
    expect(names).toContain('在跑甲')
    expect(names).toContain('结项乙')
    expect(names).toContain('取消丙')

    const closed = all.body.projects.find((p) => p.name === '结项乙')
    expect(closed.status).toBe('closed')
    expect(closed.planStartDate).toBe('2026-08-01')
    expect(closed.planEndDate).toBe('2026-08-31')
    expect(closed.actualStartDate).toBeTruthy() // S29 启动日自动落
    expect(closed.actualEndDate).toBe(today()) // 终结落实际结束日（北京日历日）

    const def = await authed(ctx.app, cookie, 'GET', '/api/v1/projects')
    expect(def.body.projects.map((p) => p.name)).toEqual(['在跑甲']) // 缺省=仅进行中（既有行为不变）
  })
})

describe('S30-7 服务端查询与分页（v0.79）', () => {
  let cookie
  // 数据画像（全部建在独立新库）：active 甲(高优/逾期/有交付) 乙(中优/只有交付) 丙(中优/无日期=未排期) 丁(低优/客户命中)
  //   + closed 戊 + cancelled 己（冻结逾期任务 2 条，其中 1 条未指派）
  it('S30-7: q 模糊查询——分词 AND、命中 项目名/客户名/牵头人名/类型名、LIKE 通配符字面匹配', async () => {
    ctx = await setupApp()
    cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const yesterday = addDays(today(), -1)
    const mk = (over) => authed(ctx.app, cookie, 'POST', '/api/v1/projects', {
      templateCode: 'lianmai_365', leadMemberId: ctx.members.lead.id, tasks: [], ...over,
    })
    const jia = await mk({ name: '闪光大讲堂', clientName: '闪光科技', priority: 'high',
      planStartDate: '2026-09-01', planEndDate: addDays(today(), 10), tasks: ['讲堂任务'] })
    expect(jia.status).toBe(201)
    await authed(ctx.app, cookie, 'PATCH', `/api/v1/tasks/${jia.body.tasks[0].id}`,
      { planEndDate: yesterday, responsibleMemberId: ctx.members.lead.id }) // 唯一逾期任务（有主）
    const yi = await mk({ name: '闪光小灶课', priority: 'medium', typeCode: 'afternoon_tea', planEndDate: addDays(today(), 5) })
    expect(yi.status).toBe(201)
    const bing = await mk({ name: '外部咨询一期', clientName: '远景资本', priority: 'medium', typeCode: 'consulting_1v1' }) // 无日期=未排期
    expect(bing.status).toBe(201)
    const ding = await mk({ name: '内训定制课', priority: 'low', typeCode: 'internal_training' }) // 无日期=未排期
    expect(ding.status).toBe(201)
    const wu = await mk({ name: '已完结项目' })
    await authed(ctx.app, cookie, 'POST', `/api/v1/projects/${wu.body.id}/close`, { summary: '交付完成' })
    const ji = await mk({ name: '已取消项目', tasks: ['冻结任务甲', '冻结任务乙'] })
    await authed(ctx.app, cookie, 'PATCH', `/api/v1/tasks/${ji.body.tasks[0].id}`,
      { planEndDate: yesterday, responsibleMemberId: ctx.members.lead.id }) // 冻结逾期（有主）
    await authed(ctx.app, cookie, 'PATCH', `/api/v1/tasks/${ji.body.tasks[1].id}`, { planEndDate: yesterday }) // 冻结逾期（未指派）
    await authed(ctx.app, cookie, 'POST', `/api/v1/projects/${ji.body.id}/cancel`, { reason: '战略调整' })

    const names = async (qs) => (await authed(ctx.app, cookie, 'GET', `/api/v1/projects${qs}`)).body.projects.map((p) => p.name)
    expect(await names('?q=闪光')).toEqual(['闪光大讲堂', '闪光小灶课']) // 项目名子串
    expect(await names('?q=远景')).toEqual(['外部咨询一期']) // 客户名
    expect(await names('?q=李四')).toEqual([]) // 牵头人名：三项目牵头人均为张三 → 无命中
    expect(await names('?q=张三')).toHaveLength(4) // 牵头人名命中全部在跑
    expect(await names('?q=下午茶')).toEqual(['闪光小灶课']) // 类型名（afternoon_tea=商业下午茶）
    expect(await names('?q=闪光 远景')).toEqual([]) // 多词 AND：无项目同时命中两词
    expect(await names(`?q=${encodeURIComponent('%')}`)).toEqual([]) // LIKE 通配符按字面匹配，不放大为全量
    expect(await names('?q=不存在的词')).toEqual([])

    const miss = await authed(ctx.app, cookie, 'GET', '/api/v1/projects?q=不存在的词')
    expect(miss.body.total).toBe(0)
  })

  it('S30-7: 分页切片与 total/facets——facets 不受状态选择影响、只受 q/priority 影响', async () => {
    const p1 = await authed(ctx.app, cookie, 'GET', '/api/v1/projects?page=1&pageSize=2')
    expect(p1.body.total).toBe(4) // 默认仅进行中：甲乙丙丁
    expect(p1.body.projects).toHaveLength(2)
    expect(p1.body.projects[0].name).toBe('闪光大讲堂') // 高优在前（服务端排序）
    const p2 = await authed(ctx.app, cookie, 'GET', '/api/v1/projects?page=2&pageSize=2')
    expect(p2.body.projects).toHaveLength(2)
    const p3 = await authed(ctx.app, cookie, 'GET', '/api/v1/projects?page=3&pageSize=2')
    expect(p3.body.projects).toEqual([]) // 越界页为空，total 仍 4
    expect(p3.body.total).toBe(4)

    // facets：三态计数/未排期/逾期任务总数——不受 status 选择影响（选 active 也看得到 已结项 1）
    const f = p1.body.facets
    expect(f.byStatus).toEqual({ active: 4, closed: 1, cancelled: 1 })
    expect(f.unscheduled).toBe(4) // 全状态口径：外部咨询一期 + 内训定制课 + 已完结项目 + 已取消项目（均无计划日期）
    expect(f.overdueTasks).toBe(3) // 甲 1 + 己 冻结 2（全状态口径）
    const withQ = await authed(ctx.app, cookie, 'GET', '/api/v1/projects?q=闪光&page=1&pageSize=1')
    expect(withQ.body.total).toBe(2)
    expect(withQ.body.facets.byStatus).toEqual({ active: 2, closed: 0, cancelled: 0 }) // facets 受 q 影响
    const noPage = await authed(ctx.app, cookie, 'GET', '/api/v1/projects')
    expect(noPage.body.projects).toHaveLength(4) // 不带分页参数=全量返回（Dashboard 等既有消费方）
    expect(noPage.body.total).toBe(4)

    // 参数非法 400
    for (const bad of ['page=0', 'page=-1', 'pageSize=0', 'pageSize=101', 'sort=bogus', 'priority=urgent']) {
      const r = await authed(ctx.app, cookie, 'GET', `/api/v1/projects?${bad}`)
      expect(r.status, bad).toBe(400)
    }
  })

  it('S30-7: priority/sort/unscheduled/overdue 服务端过滤与排序（无日期沉底不穿插）', async () => {
    const names = async (qs) => (await authed(ctx.app, cookie, 'GET', `/api/v1/projects${qs}`)).body.projects.map((p) => p.name)
    expect(await names('?priority=high')).toEqual(['闪光大讲堂'])
    expect(await names('?priority=low')).toEqual(['内训定制课'])
    expect(await names('?unscheduled=1')).toEqual(['外部咨询一期', '内训定制课']) // 快捷过滤：双日期全空
    expect(await names('?overdue=1')).toEqual(['闪光大讲堂']) // 有逾期任务的在跑项目（冻结任务不计）

    // sort=delivery：进行中且填交付日期的按临近升序在前，无日期沉底成组不穿插
    const delivery = await names('?sort=delivery')
    expect(delivery[0]).toBe('闪光小灶课') // planEndDate=+5
    expect(delivery[1]).toBe('闪光大讲堂') // planEndDate=+10
    expect(new Set(delivery.slice(2))).toEqual(new Set(['外部咨询一期', '内训定制课'])) // 无日期沉底

    // sort=activity：最近事件降序、无事件沉底（给乙造一条最新事件）
    const yiId = (await authed(ctx.app, cookie, 'GET', '/api/v1/projects?q=小灶')).body.projects[0].id
    await authed(ctx.app, cookie, 'POST', `/api/v1/projects/${yiId}/events`, { eventType: 'progress', summary: '最新进展' })
    const activity = await names('?sort=activity')
    expect(activity[0]).toBe('闪光小灶课')

    // sort=updated：最近更新在前
    const updated = await names('?sort=updated&priority=low')
    expect(updated).toEqual(['内训定制课'])
  })
})
