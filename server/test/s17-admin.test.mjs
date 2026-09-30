import { describe, it, expect, afterAll } from 'vitest'
import { setupApp, loginCookie, authed } from './helpers.mjs'
import { upsertChannel } from '../engine/tasks.js'
import { ingestMessages } from '../brain/extract.js'
import { queryMetric } from '../engine/metrics.js'

// PRD S17 — 配置台：身份表维护、离职强制转交、阈值即时生效、LLM/IM 连通性测试

let ctx
afterAll(() => ctx?.db.close())

function fakeLlm(handler) {
  return { name: 'fake', complete: async (m) => handler(m) }
}

describe('S17 配置台', () => {
  it('S17-1: 飞书 id 变更后新 id 生效、历史事件不回改', async () => {
    ctx = await setupApp()
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const p = await authed(ctx.app, cookie, 'POST', '/api/v1/projects', {
      name: '客户P系统', templateCode: 'software_delivery', leadMemberId: ctx.members.lead.id,
    })
    const ch = upsertChannel(ctx.db, { platform: 'feishu', groupKey: 'oc_p', channelType: 'dedicated', projectId: p.body.id })
    const llm = fakeLlm(() => JSON.stringify({ events: [{ nature: 'record', eventType: 'progress', summary: '进展', confidence: 0.9 }] }))

    await ingestMessages(ctx.db, ch, [{ id: 'm1', speakerId: 'fs_zhang', text: '旧 id 发言', ts: Date.now() }], { llm })
    const oldEv = ctx.db.prepare(`SELECT * FROM project_events WHERE raw_snapshot = '旧 id 发言'`).get()
    expect(oldEv.speaker_member_id).toBe(ctx.members.lead.id)

    await authed(ctx.app, cookie, 'PATCH', `/api/v1/members/${ctx.members.lead.id}`, { feishuId: 'fs_zhang_new' })
    await ingestMessages(ctx.db, ch, [{ id: 'm2', speakerId: 'fs_zhang_new', text: '新 id 发言', ts: Date.now() }], { llm })
    const newEv = ctx.db.prepare(`SELECT * FROM project_events WHERE raw_snapshot = '新 id 发言'`).get()
    expect(newEv.speaker_member_id).toBe(ctx.members.lead.id)
    expect(ctx.db.prepare(`SELECT speaker_member_id FROM project_events WHERE id = ?`).get(oldEv.id).speaker_member_id).toBe(ctx.members.lead.id)
  })

  it('S17-2: 离职强制转交：未转完 409 并列出缺项；转完软删+令牌会话联动失效', async () => {
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const p = await authed(ctx.app, cookie, 'POST', '/api/v1/projects', {
      name: '客户Q系统', templateCode: 'software_delivery', leadMemberId: ctx.members.lead.id,
    })
    const zhangCookie = await loginCookie(ctx.app, 'zhangsan', 'pass-123456')
    const tok = await authed(ctx.app, zhangCookie, 'POST', '/api/v1/auth/tokens', { scope: 'write' })

    const blocked = await authed(ctx.app, cookie, 'POST', `/api/v1/members/${ctx.members.lead.id}/offboard`, {})
    expect(blocked.status).toBe(409)
    expect(blocked.body.missingProjects).toContain(p.body.id)
    expect(blocked.body.missingTasks.length).toBeGreaterThanOrEqual(6)

    const ok = await authed(ctx.app, cookie, 'POST', `/api/v1/members/${ctx.members.lead.id}/offboard`, {
      handover: {
        projects: blocked.body.missingProjects.map((id) => ({ projectId: id, toMemberId: ctx.members.dev.id })),
        tasks: blocked.body.missingTasks.map((id) => ({ taskId: id, toMemberId: ctx.members.dev.id })),
      },
    })
    expect(ok.status).toBe(200)
    expect(ok.body.member.status).toBe('offboarded')
    // 项目与任务已转交
    expect(ctx.db.prepare('SELECT lead_member_id FROM projects WHERE id = ?').get(p.body.id).lead_member_id).toBe(ctx.members.dev.id)
    // 令牌联动撤销 + 登录失效
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/v1/agent/sql', payload: { sql: 'SELECT 1' },
      headers: { authorization: `Bearer ${tok.body.token}` },
    })
    expect(res.statusCode).toBe(401)
    const relogin = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'zhangsan', password: 'pass-123456' } })
    expect(relogin.statusCode).toBe(401)
  })

  it('S17-3: 修改沉默阈值后全局视图按新口径即时刷新', async () => {
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const p = await authed(ctx.app, cookie, 'POST', '/api/v1/projects', {
      name: '阈值项目', templateCode: 'software_delivery', leadMemberId: ctx.members.dev.id,
    })
    await authed(ctx.app, cookie, 'POST', `/api/v1/projects/${p.body.id}/events`, { eventType: 'progress', summary: '五天前进展' })
    ctx.db.prepare('UPDATE project_events SET business_time = ? WHERE project_id = ?').run(Date.now() - 5 * 86400000, p.body.id)

    const before = queryMetric(ctx.db, 'silent_projects', { groupBy: 'priority' })
    expect(before.rows.every((r) => !String(r.priority).includes('不存在'))).toBe(true)
    // 默认沉默 7 天：5 天不算沉默
    const flat = queryMetric(ctx.db, 'silent_projects', { groupBy: 'priority' })
    const cnt = flat.rows.reduce((s, r) => s + r.count, 0)
    const hasThresholdProj = ctx.db.prepare(
      `SELECT COUNT(*) AS n FROM projects p WHERE p.name = '阈值项目' AND COALESCE((SELECT MAX(business_time) FROM project_events e WHERE e.project_id = p.id), p.created_at) < ?`
    ).get(Date.now() - 7 * 86400000).n
    expect(hasThresholdProj).toBe(0)

    await authed(ctx.app, cookie, 'PUT', '/api/v1/admin/settings/thresholds', { silentDays: 3, healthRed: { silentDays: 3, overdue: 3 }, healthYellow: { silentDays: 2, overdue: 1 } })
    const after = queryMetric(ctx.db, 'silent_projects', { groupBy: 'priority' })
    const cnt2 = after.rows.reduce((s, r) => s + r.count, 0)
    expect(cnt2).toBeGreaterThan(cnt)
  })

  it('S17-4: DeepSeek 测试连接——未配置/不可达均回显成败原因', async () => {
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const noKey = await authed(ctx.app, cookie, 'POST', '/api/v1/admin/test-llm', {})
    expect(noKey.body.ok).toBe(false)
    expect(noKey.body.reason).toContain('未配置')
    const unreachable = await authed(ctx.app, cookie, 'POST', '/api/v1/admin/test-llm', {
      baseUrl: 'http://127.0.0.1:9', apiKey: 'sk-test', model: 'deepseek-chat',
    })
    expect(unreachable.body.ok).toBe(false)
    expect(typeof unreachable.body.reason).toBe('string')
  })

  it('S17-5: 企微连通性——未部署 SDK 给出明确指引（附录 A.2）', async () => {
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const res = await authed(ctx.app, cookie, 'POST', '/api/v1/admin/test-im/wecom')
    expect(res.body.ok).toBe(false)
    expect(res.body.reason).toContain('A.2')
    const fs = await authed(ctx.app, cookie, 'POST', '/api/v1/admin/test-im/feishu')
    expect(fs.body.ok).toBe(false)
    expect(fs.body.reason).toContain('A.1')
  })
})

describe('S17 配置台改版：角色治理与类型/模板管理', () => {
  it('S17-6: 系统管理员变更成员角色后，配置台访问权立即随新角色生效', async () => {
    const local = await setupApp()
    try {
      const adminCookie = await loginCookie(local.app, 'admin', 'admin-pass-123')
      const lisiCookie = await loginCookie(local.app, 'lisi', 'pass-123456')

      const before = await authed(local.app, lisiCookie, 'GET', '/api/v1/admin/settings')
      expect(before.status).toBe(403)

      const up = await authed(local.app, adminCookie, 'PATCH', `/api/v1/members/${local.members.dev.id}`, { role: 'admin' })
      expect(up.status).toBe(200)
      const during = await authed(local.app, lisiCookie, 'GET', '/api/v1/admin/settings')
      expect(during.status).toBe(200)

      const down = await authed(local.app, adminCookie, 'PATCH', `/api/v1/members/${local.members.dev.id}`, { role: 'member' })
      expect(down.status).toBe(200)
      const after = await authed(local.app, lisiCookie, 'GET', '/api/v1/admin/settings')
      expect(after.status).toBe(403)

      // 普通成员不能配置任何人的角色
      const forbidden = await authed(local.app, lisiCookie, 'PATCH', `/api/v1/members/${local.members.key.id}`, { role: 'admin' })
      expect(forbidden.status).toBe(403)
    } finally {
      local.db.close()
    }
  })

  it('S17-8: 停用类型后立项不可选且历史项目不受影响；模板编辑只影响未来立项', async () => {
    const local = await setupApp()
    try {
    const adminCookie = await loginCookie(local.app, 'admin', 'admin-pass-123')
    const memberCookie = await loginCookie(local.app, 'lisi', 'pass-123456')

    // 新建任务模板（阶段 + 任务）
    const tpl = await authed(local.app, adminCookie, 'POST', '/api/v1/admin/templates', {
      code: 'sre_ops', name: '运维专项',
      tasks: [{ title: '变更评审' }, { title: '执行割接' }], // v0.6：纯任务清单，无阶段层
    })
    expect(tpl.status).toBe(201)
    expect(tpl.body.template.stages).toBeUndefined()
    expect(tpl.body.template.tasks.map((t) => t.title)).toEqual(['变更评审', '执行割接'])

    // 新建项目类型并绑定该模板
    const t = await authed(local.app, adminCookie, 'POST', '/api/v1/admin/project-types', {
      code: 'ops', name: '运维', defaultTemplateId: tpl.body.template.id,
    })
    expect(t.status).toBe(201)
    expect(t.body.type.defaultTemplateName).toBe('运维专项')
    expect(t.body.type.status).toBe('active')

    // 类型清单全员可读（立项表单用，D1 透明）
    const list = await authed(local.app, memberCookie, 'GET', '/api/v1/project-types')
    expect(list.status).toBe(200)
    expect(list.body.types.map((x) => x.code)).toContain('ops')

    // 按类型立项：套用绑定模板，任务责任人默认=牵头人
    const p1 = await authed(local.app, adminCookie, 'POST', '/api/v1/projects', {
      name: '割接项目', typeCode: 'ops', leadMemberId: local.members.lead.id,
    })
    expect(p1.status).toBe(201)
    expect(p1.body.typeName).toBe('运维')
    expect(p1.body.templateCode).toBe('sre_ops')
    expect(p1.body.tasks.map((x) => x.title)).toEqual(['变更评审', '执行割接'])
    expect(p1.body.tasks.every((x) => x.responsibleMemberId === local.members.lead.id)).toBe(true)

    // 编辑模板（整体替换任务清单）→ 只影响未来立项
    const upd = await authed(local.app, adminCookie, 'PATCH', `/api/v1/admin/templates/${tpl.body.template.id}`, {
      tasks: [{ title: '变更评审' }, { title: '执行割接' }, { title: '回滚预案验证' }],
    })
    expect(upd.status).toBe(200)
    expect(upd.body.template.tasks).toHaveLength(3)
    const hist1 = await authed(local.app, adminCookie, 'GET', `/api/v1/projects/${p1.body.id}`)
    expect(hist1.body.tasks.map((x) => x.title)).toEqual(['变更评审', '执行割接'])
    const p2 = await authed(local.app, adminCookie, 'POST', '/api/v1/projects', {
      name: '第二次割接', typeCode: 'ops', leadMemberId: local.members.lead.id,
    })
    expect(p2.body.tasks.map((x) => x.title)).toEqual(['变更评审', '执行割接', '回滚预案验证'])

    // 停用类型 → 立项 400，历史项目不受影响
    const dis = await authed(local.app, adminCookie, 'PATCH', `/api/v1/admin/project-types/${t.body.type.id}`, { status: 'disabled' })
    expect(dis.status).toBe(200)
    const list2 = await authed(local.app, memberCookie, 'GET', '/api/v1/project-types')
    expect(list2.body.types.find((x) => x.code === 'ops').status).toBe('disabled')
    const blocked = await authed(local.app, adminCookie, 'POST', '/api/v1/projects', {
      name: '不该成功', typeCode: 'ops', leadMemberId: local.members.lead.id,
    })
    expect(blocked.status).toBe(400)
    expect(blocked.body.message).toContain('停用')
    const hist2 = await authed(local.app, adminCookie, 'GET', `/api/v1/projects/${p1.body.id}`)
    expect(hist2.body.typeName).toBe('运维')
    expect(hist2.body.tasks).toHaveLength(2)

    // 被类型绑定的模板不可删除（防引用悬空）
    const del = await authed(local.app, adminCookie, 'DELETE', `/api/v1/admin/templates/${tpl.body.template.id}`)
    expect(del.status).toBe(409)

    // 校验：类型编码唯一、绑定不存在的模板 → 400
    const dup = await authed(local.app, adminCookie, 'POST', '/api/v1/admin/project-types', {
      code: 'ops', name: '重复', defaultTemplateId: tpl.body.template.id,
    })
    expect(dup.status).toBe(400)
    const badTpl = await authed(local.app, adminCookie, 'POST', '/api/v1/admin/project-types', {
      code: 'ops2', name: '坏绑定', defaultTemplateId: 99999,
    })
    expect(badTpl.status).toBe(400)
    } finally {
      local.db.close()
    }
  })
})
