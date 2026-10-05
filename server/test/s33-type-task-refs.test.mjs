import { describe, it, expect, afterAll } from 'vitest'
import { setupApp, loginCookie, authed } from './helpers.mjs'
import { dailyReport } from '../brain/report.js'
import { today } from '../db/time.js'

// PRD S33 — 类型模板任务参考资料（v0.33）：模板任务可挂参考链接（1 任务 N 条，≤10 条防呆），
// 类型编辑给出 tasks 即任务+参考整体替换；立项时参考随标题拷贝进 task_refs（S23 全套能力接管，
// 推送自动附带）；自定义覆盖纯标题=不带模板参考，显式 {title, refs} 才带。

let ctx
afterAll(() => ctx?.db.close())

const dayOff = (n) => new Date(Date.parse(`${today()}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

async function admin() {
  return loginCookie(ctx.app, 'admin', 'admin-pass-123')
}

/** 建一个带参考的测试类型：任务项混合三种形态（对象带 refs / 纯字符串 / 纯 {title}）。 */
async function mkType(code) {
  const res = await authed(ctx.app, await admin(), 'POST', '/api/v1/admin/project-types', {
    code, name: `类型-${code}`,
    tasks: [
      {
        title: '确认排期', refs: [
          { title: '排期 SOP', url: 'https://wiki.example.com/paiqi', note: '先看第二节' },
          { title: '日历模板', url: 'https://wiki.example.com/cal' },
        ],
      },
      '准备物料',
      { title: '执行交付' },
    ],
  })
  if (res.status !== 201) throw new Error(`mkType failed: ${res.status} ${JSON.stringify(res.body)}`)
  return res.body.type
}

describe('S33 类型模板任务参考资料', () => {
  it('S33-1: 任务项可携带 refs（校验同 S23：标题必填/http(s)/每任务 ≤10 条）；编辑整体替换；读取回显', async () => {
    ctx = await setupApp()
    const cookie = await admin()

    const t = await mkType('s33a')
    expect(t.tasks).toHaveLength(3)
    // 回显：混合形态兼容；refs 字段逐项一致且有序，未挂参考的任务为空数组
    expect(t.tasks[0].refs).toEqual([
      { title: '排期 SOP', url: 'https://wiki.example.com/paiqi', note: '先看第二节' },
      { title: '日历模板', url: 'https://wiki.example.com/cal', note: null },
    ])
    expect(t.tasks[1].title).toBe('准备物料')
    expect(t.tasks[1].refs).toEqual([])
    expect(t.tasks[2].refs).toEqual([])

    // 校验：refs 缺标题 / 非 http(s) 链接 → 400（创建与编辑同校验）
    const bad1 = await authed(ctx.app, cookie, 'POST', '/api/v1/admin/project-types', {
      code: 's33bad1', name: 'x', tasks: [{ title: '甲', refs: [{ url: 'https://x.co' }] }],
    })
    expect(bad1.status).toBe(400)
    const bad2 = await authed(ctx.app, cookie, 'POST', '/api/v1/admin/project-types', {
      code: 's33bad2', name: 'x', tasks: [{ title: '甲', refs: [{ title: 'y', url: 'ftp://z.co' }] }],
    })
    expect(bad2.status).toBe(400)
    const bad3 = await authed(ctx.app, cookie, 'PATCH', `/api/v1/admin/project-types/${t.id}`, {
      tasks: [{ title: '甲', refs: [{ title: 'y', url: 'not-a-url' }] }],
    })
    expect(bad3.status).toBe(400)

    // 每任务参考超 10 条 → 400（防呆上限）
    const eleven = Array.from({ length: 11 }, (_, i) => ({ title: `R${i}`, url: `https://x.co/${i}` }))
    const bad4 = await authed(ctx.app, cookie, 'POST', '/api/v1/admin/project-types', {
      code: 's33bad4', name: 'x', tasks: [{ title: '甲', refs: eleven }],
    })
    expect(bad4.status).toBe(400)
    // 10 条恰好合法（边界）
    const ten = eleven.slice(0, 10)
    const edge = await authed(ctx.app, cookie, 'POST', '/api/v1/admin/project-types', {
      code: 's33edge', name: 'x', tasks: [{ title: '甲', refs: ten }],
    })
    expect(edge.status).toBe(201)
    expect(edge.body.type.tasks[0].refs).toHaveLength(10)

    // 编辑整体替换：任务行与参考行一起换，旧参考行物理清除（配置对象无软删）
    const upd = await authed(ctx.app, cookie, 'PATCH', `/api/v1/admin/project-types/${t.id}`, {
      tasks: [{ title: '新版确认排期', refs: [{ title: '新 SOP', url: 'https://wiki.example.com/v2' }] }, '新版收尾'],
    })
    expect(upd.status).toBe(200)
    expect(upd.body.type.tasks[0].refs).toEqual([{ title: '新 SOP', url: 'https://wiki.example.com/v2', note: null }])
    expect(upd.body.type.tasks[1].refs).toEqual([])
    const left = ctx.db.prepare(`SELECT COUNT(*) AS n FROM project_type_task_refs r JOIN project_type_tasks tt ON tt.id = r.type_task_id WHERE tt.type_id = ?`).get(t.id)
    expect(left.n).toBe(1)
  })

  it('S33-2: 立项未自定义 → 模板参考逐字段拷贝为任务参考资料（创建人=立项人，顺序一致）；日报推送附带', async () => {
    ctx = await setupApp()
    const cookie = await admin()
    await mkType('s33b')

    const p = await authed(ctx.app, cookie, 'POST', '/api/v1/projects', {
      name: '模板参考项目', typeCode: 's33b', leadMemberId: ctx.members.lead.id, planEndDate: dayOff(30),
    })
    expect(p.status).toBe(201)
    expect(p.body.tasks).toHaveLength(3)
    expect(p.body.tasks[0].refCount).toBe(2) // 项目详情任务行「参考 N」徽标
    expect(p.body.tasks[1].refCount).toBe(0)

    const refs = (await authed(ctx.app, cookie, 'GET', `/api/v1/tasks/${p.body.tasks[0].id}/refs`)).body.refs
    expect(refs.map((r) => [r.title, r.url, r.note])).toEqual([
      ['排期 SOP', 'https://wiki.example.com/paiqi', '先看第二节'],
      ['日历模板', 'https://wiki.example.com/cal', null],
    ])
    expect(refs.every((r) => r.createdByName === '管理员')).toBe(true)

    // 日报「我的任务」自动附带模板预填参考（S23-3 同构，推送链路零改动）
    await dailyReport(ctx.db, { force: true })
    const push = ctx.db.prepare(`SELECT * FROM pushes WHERE push_type = 'daily_report' AND recipient_member_id = ?`).get(ctx.members.lead.id)
    expect(push.body).toContain('【参考资料】')
    expect(push.body).toContain('排期 SOP https://wiki.example.com/paiqi')
  })

  it('S33-3: 自定义清单纯标题=不带模板参考；载荷任务项显式给 refs 才带（同校验）', async () => {
    ctx = await setupApp()
    const cookie = await admin()
    await mkType('s33c')

    const p = await authed(ctx.app, cookie, 'POST', '/api/v1/projects', {
      name: '自定义纯标题', typeCode: 's33c', leadMemberId: ctx.members.lead.id,
      tasks: ['自定义甲', '自定义乙'],
    })
    expect(p.status).toBe(201)
    expect(p.body.tasks.every((t) => t.refCount === 0)).toBe(true)
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM task_refs').get().n).toBe(0)

    const p2 = await authed(ctx.app, cookie, 'POST', '/api/v1/projects', {
      name: '自定义带参考', typeCode: 's33c', leadMemberId: ctx.members.lead.id,
      tasks: [{ title: '自定义丙', refs: [{ title: '交付清单', url: 'https://wiki.example.com/deliver' }] }, '自定义丁'],
    })
    expect(p2.status).toBe(201)
    expect(p2.body.tasks[0].refCount).toBe(1)
    expect(p2.body.tasks[1].refCount).toBe(0)
    const refs = (await authed(ctx.app, cookie, 'GET', `/api/v1/tasks/${p2.body.tasks[0].id}/refs`)).body.refs
    expect(refs[0]).toMatchObject({ title: '交付清单', url: 'https://wiki.example.com/deliver' })

    const bad = await authed(ctx.app, cookie, 'POST', '/api/v1/projects', {
      name: '坏参考', typeCode: 's33c', leadMemberId: ctx.members.lead.id,
      tasks: [{ title: 'x', refs: [{ title: 'y', url: 'ftp://z.co' }] }],
    })
    expect(bad.status).toBe(400)
  })

  it('S33-4: 删除无引用类型 → 任务行与参考行同事务级联清除（S17-13 同构）', async () => {
    ctx = await setupApp()
    const cookie = await admin()
    const t = await mkType('s33d')
    const taskIds = ctx.db.prepare('SELECT id FROM project_type_tasks WHERE type_id = ?').all(t.id).map((r) => r.id)
    expect(taskIds.length).toBe(3)
    expect(ctx.db.prepare(`SELECT COUNT(*) AS n FROM project_type_task_refs WHERE type_task_id IN (${taskIds.map(() => '?').join(',')})`).get(...taskIds).n).toBe(2)

    const del = await authed(ctx.app, cookie, 'DELETE', `/api/v1/admin/project-types/${t.id}`)
    expect(del.status).toBe(200)
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM project_type_tasks WHERE type_id = ?').get(t.id).n).toBe(0)
    expect(ctx.db.prepare(`SELECT COUNT(*) AS n FROM project_type_task_refs WHERE type_task_id IN (${taskIds.map(() => '?').join(',')})`).get(...taskIds).n).toBe(0)
  })

  it('S33-5: 新表随迁移建立且为空（存量预置类型不回填），既有类型清单不受影响', async () => {
    ctx = await setupApp()
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM project_type_task_refs').get().n).toBe(0)
    const list = (await authed(ctx.app, await admin(), 'GET', '/api/v1/project-types')).body.types
    const lm = list.find((t) => t.code === 'lianmai_365')
    expect(lm.tasks).toHaveLength(14)
    expect(lm.tasks.every((t) => t.refs.length === 0)).toBe(true)
  })
})
