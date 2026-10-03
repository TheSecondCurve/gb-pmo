import { describe, it, expect, afterAll } from 'vitest'
import { setupApp, setupDb, loginCookie, authed } from './helpers.mjs'
import { migrate } from '../db/index.mjs'

// PRD S31（v0.30）— 四类交付项目类型预置：从「闪光新版知识库」SOP 蒸馏任务清单，
// migration 0017 铺库 + 停用三个 v0.1 占位类型（软删）。清单标题即契约，与迁移逐字一致。

const EXPECTED = {
  lianmai_365: {
    name: '365连麦',
    count: 14,
    first: '创建本场连麦记录并确定主负责人',
    last: '更新连麦登记表用户状态',
  },
  consulting_1v1: {
    name: '1v1商业咨询',
    count: 12,
    first: '确认用户预约与下单并入库',
    last: '归档文稿录音与策略报告并同步用户',
  },
  afternoon_tea: {
    name: '商业下午茶',
    count: 16,
    first: '项目启动与数据初始化（确定城市、时间与负责人）',
    last: '归档资料、收集用户反馈并核对场次费用',
  },
  internal_training: {
    name: '内训课',
    count: 14,
    first: '盘点用户高频问题并确定选题',
    last: '归档资料并完成项目复盘',
  },
}
const PLACEHOLDER_CODES = ['software_delivery', 'consulting', 'custom']

let ctx
afterAll(() => ctx?.db.close())

describe('S31 四类交付项目类型预置', () => {
  it('S31-1: 当迁移完成后，应存在四个启用（active）的交付项目类型，描述含知识库 SOP 链接', async () => {
    ctx = await setupApp()
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const res = await authed(ctx.app, cookie, 'GET', '/api/v1/project-types')
    expect(res.status).toBe(200)
    const byCode = Object.fromEntries(res.body.types.map((t) => [t.code, t]))
    for (const [code, exp] of Object.entries(EXPECTED)) {
      expect(byCode[code], `缺少类型 ${code}`).toBeTruthy()
      expect(byCode[code].name).toBe(exp.name)
      expect(byCode[code].status).toBe('active')
      expect(byCode[code].description).toContain('https://ghy685ffir.feishu.cn/wiki/')
    }
  })

  it('S31-2: 当查看任一预置类型的任务清单时，应得到有序蒸馏清单（首条启动项、末条归档/状态更新项）', async () => {
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const res = await authed(ctx.app, cookie, 'GET', '/api/v1/project-types')
    const byCode = Object.fromEntries(res.body.types.map((t) => [t.code, t]))
    for (const [code, exp] of Object.entries(EXPECTED)) {
      const titles = byCode[code].tasks.map((t) => t.title)
      expect(titles.length, `${code} 任务数`).toBe(exp.count)
      expect(titles[0], `${code} 首条`).toBe(exp.first)
      expect(titles[titles.length - 1], `${code} 末条`).toBe(exp.last)
    }
  })

  it('S31-3: 当迁移完成后，占位类型应为停用态且不可再立项（历史项目不受影响）', async () => {
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const res = await authed(ctx.app, cookie, 'GET', '/api/v1/project-types')
    const byCode = Object.fromEntries(res.body.types.map((t) => [t.code, t]))
    for (const code of PLACEHOLDER_CODES) {
      expect(byCode[code], `缺少占位类型 ${code}`).toBeTruthy()
      expect(byCode[code].status).toBe('disabled')
    }
    // 停用类型立项应 400（S17-8 既有校验）
    const create = await authed(ctx.app, cookie, 'POST', '/api/v1/projects', {
      name: '旧占位类型立项', typeCode: 'software_delivery', leadMemberId: ctx.members.lead.id,
    })
    expect(create.status).toBe(400)
    expect(create.body.message).toContain('项目类型已停用')
  })

  it('S31-4: 当用预置类型（365连麦）立项且未自定义清单时，应按类型清单实例化任务（source=template）', async () => {
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const res = await authed(ctx.app, cookie, 'POST', '/api/v1/projects', {
      name: '2026-10-10 365连麦', typeCode: 'lianmai_365', leadMemberId: ctx.members.lead.id,
    })
    expect(res.status).toBe(201)
    const detail = res.body
    expect(detail.templateCode).toBe('lianmai_365')
    expect(detail.tasks.length).toBe(EXPECTED.lianmai_365.count)
    expect(detail.tasks[0].title).toBe(EXPECTED.lianmai_365.first)
    expect(detail.tasks.every((t) => t.source === 'template')).toBe(true)
    expect(detail.tasks.every((t) => t.status === 'todo')).toBe(true)
    expect(detail.tasks.every((t) => t.responsibleMemberId === ctx.members.lead.id)).toBe(true)
  })

  it('S31-5: 当迁移重复执行（migrations_meta 重放）时，不应产生重复的类型或任务行', () => {
    const { db } = setupDb()
    const typeCount = db.prepare('SELECT COUNT(*) AS n FROM project_types').get().n
    const taskCount = db.prepare('SELECT COUNT(*) AS n FROM project_type_tasks').get().n
    expect(migrate(db)).toBe(0) // meta 完整时重跑：零应用
    // 模拟 meta 丢失后的单文件重放：删掉 0017 记录再迁移，守卫应阻止重复插入
    db.prepare(`DELETE FROM migrations_meta WHERE name = '0017_delivery_type_templates.sql'`).run()
    expect(migrate(db)).toBeGreaterThanOrEqual(1)
    expect(db.prepare('SELECT COUNT(*) AS n FROM project_types').get().n).toBe(typeCount)
    expect(db.prepare('SELECT COUNT(*) AS n FROM project_type_tasks').get().n).toBe(taskCount)
    expect(db.prepare(`SELECT COUNT(*) AS n FROM project_type_tasks WHERE type_id = (SELECT id FROM project_types WHERE code = 'lianmai_365')`).get().n)
      .toBe(EXPECTED.lianmai_365.count)
    db.close()
  })
})
