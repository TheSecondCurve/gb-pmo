import { describe, it, expect, afterAll } from 'vitest'
import { setupApp, loginCookie, authed } from './helpers.mjs'
import { updateProject } from '../engine/projects.js'
import { updateTask, upsertChannel } from '../engine/tasks.js'
import { ingestMessages } from '../brain/extract.js'

// PRD S4-9 / S4-10（v0.47，K26）— finance（财务记录）事件类型全通道归类 + 引擎留痕摘要姓名化

let ctx
afterAll(() => ctx?.db.close())

async function mkProject(name) {
  const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
  const res = await authed(ctx.app, cookie, 'POST', '/api/v1/projects', {
    name, templateCode: 'lianmai_365', leadMemberId: ctx.members.lead.id,
  })
  if (res.status !== 201) throw new Error(`立项失败: ${res.status} ${JSON.stringify(res.body)}`)
  return res.body
}

describe('S4-9 finance（财务记录）事件类型（v0.47）', () => {
  it('S4-9: web 手动补充可归 finance（记录型自动生效）；非法事件类型仍 400', async () => {
    ctx = await setupApp()
    const p = await mkProject('财务记录A')
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const ok = await authed(ctx.app, cookie, 'POST', `/api/v1/projects/${p.id}/events`, {
      eventType: 'finance', summary: '客户确认首期款已安排', nature: 'record',
    })
    expect(ok.status).toBe(201)
    expect(ok.body.eventType).toBe('finance')
    expect(ok.body.status).toBe('effective') // 记录型自动生效（信任边界不变）
    const bad = await authed(ctx.app, cookie, 'POST', `/api/v1/projects/${p.id}/events`, {
      eventType: 'money', summary: '非法类型',
    })
    expect(bad.status).toBe(400)
  })

  it('S4-9: IM 抽取记录型可归 finance（自动生效，不进待确认队列）', async () => {
    const p = await mkProject('财务记录B')
    const ch = upsertChannel(ctx.db, { platform: 'feishu', groupKey: 'oc_fin', channelType: 'dedicated', projectId: p.id })
    const llm = {
      name: 'fake',
      complete: async () => JSON.stringify({ events: [{ nature: 'record', eventType: 'finance', summary: '客户说发票下周寄出', confidence: 0.9 }] }),
    }
    const stats = await ingestMessages(ctx.db, ch, [{ id: 'om_fin_1', speakerId: 'fs_zhang', text: '发票下周寄出', ts: Date.now() }], { llm })
    expect(stats.events).toBe(1)
    const ev = ctx.db.prepare(`SELECT * FROM project_events WHERE project_id = ? AND event_type = 'finance'`).get(p.id)
    expect(ev).toBeTruthy()
    expect(ev.nature).toBe('record')
    expect(ev.status).toBe('effective')
  })
})

describe('S4-10 留痕摘要姓名化（v0.47）', () => {
  it('S4-10: 立项摘要牵头人写姓名不写编号', async () => {
    const p = await mkProject('姓名化立项')
    const ev = ctx.db.prepare(`SELECT * FROM project_events WHERE project_id = ? AND event_type = 'decision'`).get(p.id)
    expect(ev.summary).toContain('牵头人 张三')
    expect(ev.summary).not.toMatch(/#\d+/)
  })

  it('S4-10: 优先级调整摘要写中文档位与操作人姓名', async () => {
    const p = await mkProject('姓名化优先级')
    updateProject(ctx.db, p.id, { priority: 'high' }, ctx.members.admin.id)
    const ev = ctx.db.prepare(`SELECT * FROM project_events WHERE project_id = ? AND event_type = 'priority_change' ORDER BY id DESC`).get(p.id)
    expect(ev.summary).toContain('中 → 高')
    expect(ev.summary).toContain('（管理员）')
    expect(ev.summary).not.toMatch(/#\d+/)
  })

  it('S4-10: 换牵头人摘要写双方姓名与操作人姓名', async () => {
    const p = await mkProject('姓名化牵头人')
    updateProject(ctx.db, p.id, { leadMemberId: ctx.members.dev.id }, ctx.members.admin.id)
    const ev = ctx.db.prepare(`SELECT * FROM project_events WHERE project_id = ? AND event_type = 'owner_change' ORDER BY id DESC`).get(p.id)
    expect(ev.summary).toContain('张三 → 李四')
    expect(ev.summary).toContain('（管理员）')
    expect(ev.summary).not.toMatch(/#\d+/)
  })

  it('S4-10: 任务责任人变更摘要写姓名（未指派 → 姓名 → 姓名）', async () => {
    const p = await mkProject('姓名化责任人')
    const taskId = p.tasks[0].id
    updateTask(ctx.db, taskId, { responsibleMemberId: ctx.members.dev.id }, ctx.members.lead.id)
    let ev = ctx.db.prepare(`SELECT * FROM project_events WHERE project_id = ? AND event_type = 'owner_change' ORDER BY id DESC`).get(p.id)
    expect(ev.summary).toContain('未指派 → 李四')
    expect(ev.summary).not.toMatch(/#\d+/)
    updateTask(ctx.db, taskId, { responsibleMemberId: ctx.members.key.id }, ctx.members.lead.id)
    ev = ctx.db.prepare(`SELECT * FROM project_events WHERE project_id = ? AND event_type = 'owner_change' ORDER BY id DESC`).get(p.id)
    expect(ev.summary).toContain('李四 → 王五')
    expect(ev.summary).not.toMatch(/#\d+/)
  })
})
