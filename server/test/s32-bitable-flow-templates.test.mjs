import { describe, it, expect, afterAll } from 'vitest'
import { setupApp, setupDb, loginCookie, authed } from './helpers.mjs'
import { migrate } from '../db/index.mjs'

// PRD S32（v0.32）— 九类业务线项目类型预置：从飞书「项目多维表格」（现役项目排期 Base）
// 「流程模板」表 7 类 59 步蒸馏（B端-平台合作按排期表通用进度轴①-⑬、内部-系统建设给通用骨架），
// migration 0018 铺库，与 v0.30 四类交付类型并存不替换。清单标题即契约，与迁移逐字一致。

const BASE_LINK = 'https://ghy685ffir.feishu.cn/base/'
const SISI = '（斯斯把关）'

const EXPECTED = {
  b2b_ads: {
    name: 'B端-广告商单',
    count: 11,
    sisi: 4,
    first: '接收Brief并完成需求十问核对与资料通读',
    last: '完成定档发布、互动钩子与打包回款闭环',
  },
  b2b_consulting: {
    name: 'B端-咨询陪跑',
    count: 7,
    sisi: 3,
    first: '识别并判断B端线索是否接单（斯斯把关）',
    last: '完成升单推进或脱敏案例归档（斯斯把关）',
  },
  b2b_platform: {
    name: 'B端-平台合作',
    count: 13,
    sisi: 0,
    first: '完成立项与Brief确认',
    last: '完成结案归档',
  },
  content_podcast: {
    name: '内容-播客',
    count: 11,
    sisi: 2,
    first: '确定选题并进排期表锁定档期',
    last: '归档播放数据与用户反馈并回流选题',
  },
  content_video: {
    name: '内容-视频口播',
    count: 9,
    sisi: 4,
    first: '完成口播脚本并按语气逐句过稿（斯斯把关）',
    last: '完成发布与数据回流归档',
  },
  c2c_launch: {
    name: 'C端-产品发售',
    count: 9,
    sisi: 3,
    first: '核验发售资格条件与备案状态（斯斯把关）',
    last: '归档全量数据档案',
  },
  c2c_event: {
    name: 'C端-活动',
    count: 6,
    sisi: 2,
    first: '拍板是否立项与档期（斯斯把关）',
    last: '完成转化复盘与案例入库',
  },
  c2b_cross: {
    name: '横跨C→B',
    count: 6,
    sisi: 4,
    first: '识别并标记C端用户露出的B需求（斯斯把关）',
    last: '跑通服务链路后议定分账结算（斯斯把关）',
  },
  internal_build: {
    name: '内部-系统建设',
    count: 5,
    sisi: 0,
    first: '立项并对齐目标与范围',
    last: '完成验收上线并归档复盘',
  },
}
const LEGACY_FOUR = ['lianmai_365', 'consulting_1v1', 'afternoon_tea', 'internal_training']

let ctx
afterAll(() => ctx?.db.close())

describe('S32 九类业务线项目类型预置', () => {
  it('S32-1: 当迁移完成后，应存在九个启用（active）的业务线类型（描述含多维表格链接），既有四类交付类型保持启用', async () => {
    ctx = await setupApp()
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const res = await authed(ctx.app, cookie, 'GET', '/api/v1/project-types')
    expect(res.status).toBe(200)
    const byCode = Object.fromEntries(res.body.types.map((t) => [t.code, t]))
    for (const [code, exp] of Object.entries(EXPECTED)) {
      expect(byCode[code], `缺少类型 ${code}`).toBeTruthy()
      expect(byCode[code].name).toBe(exp.name)
      expect(byCode[code].status).toBe('active')
      expect(byCode[code].description).toContain(BASE_LINK)
    }
    for (const code of LEGACY_FOUR) {
      expect(byCode[code], `既有交付类型 ${code} 应保持启用`).toBeTruthy()
      expect(byCode[code].status).toBe('active')
    }
  })

  it('S32-2: 当查看任一新类型的任务清单时，应得到有序蒸馏清单（首条启动/立项项、末条归档/结算收尾项）', async () => {
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

  it('S32-3: 当查看新类型清单时，「（斯斯把关）」后缀条数应与源表「需要斯斯=是」的步骤数一致（合计22）', async () => {
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const res = await authed(ctx.app, cookie, 'GET', '/api/v1/project-types')
    const byCode = Object.fromEntries(res.body.types.map((t) => [t.code, t]))
    let total = 0
    for (const [code, exp] of Object.entries(EXPECTED)) {
      const n = byCode[code].tasks.filter((t) => t.title.endsWith(SISI)).length
      expect(n, `${code} 斯斯把关条数`).toBe(exp.sisi)
      total += n
    }
    expect(total).toBe(22)
  })

  it('S32-4: 当用新类型（内容-播客）立项且未自定义清单时，应按类型清单实例化任务（source=template）', async () => {
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const res = await authed(ctx.app, cookie, 'POST', '/api/v1/projects', {
      name: '播客-润宇期', typeCode: 'content_podcast', leadMemberId: ctx.members.lead.id,
    })
    expect(res.status).toBe(201)
    const detail = res.body
    expect(detail.templateCode).toBe('content_podcast')
    expect(detail.tasks.length).toBe(EXPECTED.content_podcast.count)
    expect(detail.tasks[0].title).toBe(EXPECTED.content_podcast.first)
    expect(detail.tasks.every((t) => t.source === 'template')).toBe(true)
    expect(detail.tasks.every((t) => t.status === 'todo')).toBe(true)
    expect(detail.tasks.every((t) => t.responsibleMemberId === ctx.members.lead.id)).toBe(true)
  })

  it('S32-5: 当迁移重复执行（migrations_meta 重放）时，不应产生重复的类型或任务行', () => {
    const { db } = setupDb()
    const typeCount = db.prepare('SELECT COUNT(*) AS n FROM project_types').get().n
    const taskCount = db.prepare('SELECT COUNT(*) AS n FROM project_type_tasks').get().n
    expect(migrate(db)).toBe(0) // meta 完整时重跑：零应用
    // 模拟 meta 丢失后的单文件重放：删掉 0018 记录再迁移，守卫应阻止重复插入
    db.prepare(`DELETE FROM migrations_meta WHERE name = '0018_bitable_flow_templates.sql'`).run()
    expect(migrate(db)).toBeGreaterThanOrEqual(1)
    expect(db.prepare('SELECT COUNT(*) AS n FROM project_types').get().n).toBe(typeCount)
    expect(db.prepare('SELECT COUNT(*) AS n FROM project_type_tasks').get().n).toBe(taskCount)
    expect(db.prepare(`SELECT COUNT(*) AS n FROM project_type_tasks WHERE type_id = (SELECT id FROM project_types WHERE code = 'content_podcast')`).get().n)
      .toBe(EXPECTED.content_podcast.count)
    db.close()
  })
})
