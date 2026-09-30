import { describe, it, expect, afterAll } from 'vitest'
import { setupApp, loginCookie, authed } from './helpers.mjs'
import { projectDigest, personDigest } from '../brain/digest.js'
import { addEvent, confirmEvent } from '../engine/events.js'

// PRD S15 / S16 — by 项目梳理（双来源+依据+建议确认）与 by 员工梳理（跨项目聚合+冲突+超时置顶）

let ctx
afterAll(() => ctx?.db.close())

function fakeLlm(handler) {
  return { name: 'fake', complete: async (messages) => handler(messages) }
}

async function mkProject(name, leadId) {
  const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
  const res = await authed(ctx.app, cookie, 'POST', '/api/v1/projects', {
    name, templateCode: 'software_delivery', leadMemberId: leadId,
  })
  return res.body
}

describe('S15 by 项目梳理', () => {
  it('S15-1: 汇总任务面与讨论面，每条结论标注依据（任务#/事件#）', async () => {
    ctx = await setupApp()
    const p = await mkProject('客户J系统', ctx.members.lead.id)
    addEvent(ctx.db, { projectId: p.id, eventType: 'progress', nature: 'record', summary: '需求评审完成', sourcePlatform: 'feishu' })
    const target = p.tasks.find((t) => t.title.includes('开发联调'))
    const llm = fakeLlm(() =>
      JSON.stringify({
        narrative: '开发联调进度落后（任务#' + target.id + '），需求侧已确认范围（事件#1）。',
        suggestions: [{ summary: '开发联调顺延 3 天', targetTaskId: target.id, targetField: 'plan_end_date', targetValue: '2026-11-30' }],
      })
    )
    const out = await projectDigest(ctx.db, p.id, { llm })
    expect(out.narrative).toContain(`#${target.id}`)
    expect(out.eventCount).toBeGreaterThanOrEqual(1)
    expect(out.suggestions).toHaveLength(1)
    // 推送牵头人
    const push = ctx.db.prepare(`SELECT * FROM pushes WHERE push_type = 'digest' AND recipient_member_id = ? AND title LIKE '%客户J系统%'`).get(ctx.members.lead.id)
    expect(push).toBeTruthy()
  })

  it('S15-2: 排期调整建议以建议型事件呈现，人确认后才变更并留痕', async () => {
    const p = await mkProject('客户K系统', ctx.members.lead.id)
    const target = p.tasks.find((t) => t.title.includes('测试'))
    const evt = addEvent(ctx.db, {
      projectId: p.id, nature: 'suggestion', eventType: 'suggestion', summary: '[梳理建议] 测试延至月底',
      targetTaskId: target.id, targetField: 'plan_end_date', targetValue: '2026-10-31', generatedBy: 'digest',
    })
    expect(evt.status).toBe('pending')
    expect(ctx.db.prepare('SELECT plan_end_date FROM tasks WHERE id = ?').get(target.id).plan_end_date).toBeNull()
    confirmEvent(ctx.db, evt.id, ctx.members.lead.id)
    expect(ctx.db.prepare('SELECT plan_end_date FROM tasks WHERE id = ?').get(target.id).plan_end_date).toBe('2026-10-31')
    const row = ctx.db.prepare('SELECT status, decided_by FROM project_events WHERE id = ?').get(evt.id)
    expect(row.status).toBe('effective')
    expect(row.decided_by).toBe(ctx.members.lead.id)
  })

  it('S15-3: 近窗口无事件且无任务变动 → 梳理明确标注「项目沉默」', async () => {
    const p = await mkProject('沉默项目', ctx.members.dev.id)
    // 项目全部事件（含立项事件）压到 10 天前，任务 updated_at 同步压回
    addEvent(ctx.db, { projectId: p.id, eventType: 'progress', nature: 'record', summary: '早期进展' })
    ctx.db.prepare('UPDATE project_events SET business_time = ? WHERE project_id = ?').run(Date.now() - 10 * 86400000, p.id)
    ctx.db.prepare('UPDATE tasks SET updated_at = ? WHERE project_id = ?').run(Date.now() - 10 * 86400000, p.id)
    const out = await projectDigest(ctx.db, p.id, { llm: fakeLlm(() => JSON.stringify({ narrative: 'x', suggestions: [] })) })
    expect(out.silent).toBe(true)
    expect(out.title).toContain('项目沉默')
  })
})

describe('S16 by 员工梳理', () => {
  it('S16-1: 覆盖名下全部任务，跨项目聚合（v0.6：无被依赖项）', async () => {
    await mkProject('项目一', ctx.members.lead.id)
    await mkProject('项目二', ctx.members.lead.id)
    const out = await personDigest(ctx.db, ctx.members.lead.id, { llm: null })
    const expected = ctx.db
      .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE responsible_member_id = ? AND status IN ('todo','doing')`)
      .get(ctx.members.lead.id).n
    expect(out.taskCount).toBe(expected)
    expect(out.dependencyCount).toBeUndefined() // 依赖已裁剪（v0.6）
  })

  it('S16-2: 名下两项任务排期重叠 → 标出冲突并给建议', async () => {
    const p = await mkProject('项目三', ctx.members.dev.id)
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    await authed(ctx.app, cookie, 'PATCH', `/api/v1/tasks/${p.tasks[0].id}`, { planStartDate: '2026-10-01', planEndDate: '2026-10-10' })
    await authed(ctx.app, cookie, 'PATCH', `/api/v1/tasks/${p.tasks[1].id}`, { planStartDate: '2026-10-05', planEndDate: '2026-10-15' })
    const out = await personDigest(ctx.db, ctx.members.dev.id, { llm: null })
    expect(out.conflictCount).toBeGreaterThanOrEqual(1)
    expect(out.conflicts[0].length).toBe(2)
  })

  it('S16-3: 待确认建议超时 48h 未处理 → 梳理置顶提醒', async () => {
    const p = await mkProject('项目四', ctx.members.lead.id)
    const evt = addEvent(ctx.db, {
      projectId: p.id, nature: 'suggestion', eventType: 'suggestion', summary: '[抽取] 验收推迟',
      targetTaskId: p.tasks[0].id, targetField: 'plan_end_date', targetValue: '2026-10-25', generatedBy: 'extraction',
    })
    ctx.db.prepare('UPDATE project_events SET created_at = ? WHERE id = ?').run(Date.now() - 49 * 3600 * 1000, evt.id)
    const out = await personDigest(ctx.db, ctx.members.lead.id, { llm: null })
    expect(out.timedOutSuggestions).toBe(1)
    expect(out.timedOut[0].id).toBe(evt.id)
    const push = ctx.db.prepare(`SELECT * FROM pushes WHERE push_type = 'digest' AND recipient_member_id = ? AND body LIKE '%超时待确认%'`).get(ctx.members.lead.id)
    expect(push).toBeTruthy()
  })
})
