import { describe, it, expect } from 'vitest'
import { setupDb } from './helpers.mjs'
import { today, DAY_MS } from '../db/time.js'
import { createMember } from '../engine/members.js'
import { createProject, getProjectDetail, updateProject, closeProject, listProjects, projectsWithoutChannel } from '../engine/projects.js'
import { createTask, updateTask, getTask, listTasks, createMilestone, updateMilestone, upsertChannel, addTaskRecord, listTaskRecords } from '../engine/tasks.js'
import { addEvent, getEvent, confirmEvent, rejectEvent, listEvents, expireStaleSuggestions } from '../engine/events.js'
import { queryMetric, acceptanceAlarm } from '../engine/metrics.js'
import { projectDigest, personDigest } from '../brain/digest.js'
import { routeMessage } from '../brain/routing.js'
import { dailyReport } from '../brain/report.js'
import * as wecom from '../brain/connectors/wecom.js'
import * as feishu from '../brain/connectors/feishu.js'
import { label, values } from '../engine/enums.js'

// 补丁型测试（engineering-standards §3 补丁层规矩：每条用例挂场景号或标【工程防线】，新增默认进场景文件）。
// 本文件 = 校验 / 回退 / 404 / 空态分支补齐（真实行为路径，直调 engine）。

function seed(db) {
  const admin = createMember(db, { name: 'A', username: 'a', password: 'p-123456', role: 'admin' }, 1)
  const lead = createMember(db, { name: 'L', username: 'l', password: 'p-123456' }, 1)
  const off = createMember(db, { name: 'O', username: 'o', password: 'p-123456' }, 1)
  return { admin, lead, off }
}

function mk(db, leadId, name = 'P') {
  return createProject(db, { name, templateCode: 'lianmai_365', leadMemberId: leadId }, 1)
}

describe('projects 分支（S1-1 立项校验 / S29-3 终态守卫 / S29-2 结项摘要必填）', () => {
  it('校验：缺名/缺牵头人/未知模板/离职牵头人 → 400', () => {
    const { db } = setupDb()
    const s = seed(db)
    expect(() => createProject(db, { leadMemberId: s.lead.id }, 1)).toThrow()
    expect(() => createProject(db, { name: 'x' }, 1)).toThrow()
    expect(() => createProject(db, { name: 'x', leadMemberId: s.lead.id, templateCode: 'nope' }, 1)).toThrow()
    db.prepare(`UPDATE members SET status='offboarded' WHERE id=?`).run(s.off.id)
    expect(() => createProject(db, { name: 'x', leadMemberId: s.off.id }, 1)).toThrow()
    expect(() => getProjectDetail(db, 999)).toThrow()
    db.close()
  })

  it('更新：无字段早退、name/clientName/日期可改；closed 走 closeProject；重复结项/未完任务 409（v0.6 全部完成才可结项）', () => {
    const { db } = setupDb()
    const s = seed(db)
    const p = mk(db, s.lead.id, 'P1')
    expect(updateProject(db, p.id, {}, 1).id).toBe(p.id)
    const renamed = updateProject(db, p.id, { name: 'P1改', clientName: 'C', planStartDate: '2026-10-01' }, 1)
    expect(renamed.name).toBe('P1改')
    expect(() => updateProject(db, p.id, { status: 'closed' }, 1)).toThrow()
    expect(() => closeProject(db, p.id, {}, 1)).toThrow()
    for (const t of listTasks(db, { projectId: p.id })) updateTask(db, t.id, { status: 'done' }, 1)
    const closed = closeProject(db, p.id, { summary: '全部交付完成' }, 1) // v0.28：结项摘要必填
    expect(closed.status).toBe('closed')
    expect(() => closeProject(db, p.id, {}, 1)).toThrow()
    expect(listProjects(db, { statuses: ['closed'] }).length).toBe(1)
    expect(projectsWithoutChannel(db).length).toBe(0)
    db.close()
  })
})

describe('tasks/milestones/channels/task_records 分支（S1-2 D3 默认责任人 / S2-3 任务更新记录 / S17-12 渠道规则）', () => {
  it('任务：缺参 400、404、无字段早退；里程碑无字段早退；任务记录追加；渠道规则', () => {
    const { db } = setupDb()
    const s = seed(db)
    const p = mk(db, s.lead.id)
    expect(() => createTask(db, { title: 'x' }, 1)).toThrow()
    expect(() => getTask(db, 999)).toThrow()
    const t = createTask(db, { projectId: p.id, title: 'T1' }, 1)
    expect(t.responsibleMemberId).toBe(s.lead.id) // D3 默认牵头人
    expect(updateTask(db, t.id, {}, 1).id).toBe(t.id)
    expect(() => updateTask(db, 999, {}, 1)).toThrow()
    const ms = createMilestone(db, { projectId: p.id, name: 'M1', planDate: '2026-10-01' }, 1)
    expect(updateMilestone(db, ms.id, {}, 1).id).toBe(ms.id)
    expect(() => createMilestone(db, { name: 'x' }, 1)).toThrow()
    // 任务更新记录（S2-3）：追加式；空内容/未知任务拒绝
    expect(() => addTaskRecord(db, { taskId: t.id, content: '' }, 1)).toThrow()
    expect(() => addTaskRecord(db, { taskId: 999, content: 'x' }, 1)).toThrow()
    addTaskRecord(db, { taskId: t.id, content: '第一条' }, 1)
    addTaskRecord(db, { taskId: t.id, content: '第二条' }, 1)
    expect(listTaskRecords(db, t.id).map((r) => r.content)).toEqual(['第一条', '第二条'])
    // 渠道：通用群不能绑项目、专题必须绑项目、未知平台 400
    expect(() => upsertChannel(db, { platform: 'feishu', groupKey: 'g1', channelType: 'general', projectId: p.id }, 1)).toThrow()
    expect(() => upsertChannel(db, { platform: 'feishu', groupKey: 'g2', channelType: 'dedicated' }, 1)).toThrow()
    expect(() => upsertChannel(db, { platform: 'dingtalk', groupKey: 'g3' }, 1)).toThrow()
    const ch = upsertChannel(db, { platform: 'feishu', groupKey: 'g4', channelType: 'dedicated', projectId: p.id }, 1)
    expect(upsertChannel(db, { platform: 'feishu', groupKey: 'g4', name: '改名', channelType: 'dedicated', projectId: p.id }, 1).id).toBe(ch.id)
    db.close()
  })
})

describe('events 分支（S16-3 建议超时过期 / S35-4 里程碑建议字段守卫；缺参与枚举校验=【工程防线】）', () => {
  it('缺参/非法枚举 400；非 pending 确认驳回 409；无目标字段的确认；过期扫描；markPushedTo 合并', async () => {
    const { db } = setupDb()
    const s = seed(db)
    const p = mk(db, s.lead.id)
    expect(() => addEvent(db, { summary: 'x' })).toThrow()
    expect(() => addEvent(db, { projectId: p.id, summary: 'x', eventType: 'nope' })).toThrow()
    const e1 = addEvent(db, { projectId: p.id, summary: '记录', eventType: 'progress' })
    expect(() => confirmEvent(db, e1.id, 1)).toThrow()
    expect(() => rejectEvent(db, e1.id, 1)).toThrow()
    expect(() => confirmEvent(db, 999, 1)).toThrow()
    expect(() => rejectEvent(db, 999, 1)).toThrow()
    // 建议型但无目标字段：确认只翻状态
    const e2 = addEvent(db, { projectId: p.id, summary: '建议', eventType: 'suggestion', nature: 'suggestion' })
    const ok = confirmEvent(db, e2.id, 1)
    expect(ok.status).toBe('effective')
    const e3 = addEvent(db, { projectId: p.id, summary: '待过期', eventType: 'suggestion', nature: 'suggestion' })
    db.prepare('UPDATE project_events SET created_at = ? WHERE id = ?').run(Date.now() - 72 * 3600 * 1000, e3.id)
    expect(expireStaleSuggestions(db, 48)).toBeGreaterThanOrEqual(1)
    expect(getEvent(db, e3.id).status).toBe('expired')
    expect(listEvents(db, {}).length).toBeGreaterThanOrEqual(3)
    // 非法目标字段确认 → 400
    const bad = addEvent(db, { projectId: p.id, summary: '坏建议', eventType: 'suggestion', nature: 'suggestion', targetTaskId: p.tasks[0].id, targetField: 'title', targetValue: 'x' })
    expect(() => confirmEvent(db, bad.id, 1)).toThrow()
    // 里程碑非法字段
    const badMs = addEvent(db, { projectId: p.id, summary: '坏里程碑建议', eventType: 'suggestion', nature: 'suggestion', targetObject: 'milestone', targetTaskId: 1, targetField: 'name', targetValue: 'x' })
    expect(() => confirmEvent(db, badMs.id, 1)).toThrow()
    db.close()
  })
})

describe('metrics 分支（S5-3 指标目录维度守卫 / S3-5 空库采纳率）', () => {
  it('非法维度 400（逐指标）；空库采纳率 null', () => {
    const { db } = setupDb()
    seed(db)
    for (const id of ['running_projects', 'overdue_tasks', 'unassigned_tasks', 'silent_projects', 'keyperson_load', 'suggestion_acceptance']) {
      expect(() => queryMetric(db, id, { groupBy: 'nonsense' })).toThrow()
    }
    expect(() => queryMetric(db, 'nope')).toThrow()
    expect(acceptanceAlarm(db)).toBeNull()
    db.close()
  })
})

describe('routing/digest/report 分支（S3-2 分拣降级 / S15-1、S16-1 梳理 404 与叙事降级 / S18-4 日报不重复）', () => {
  it('routing：LLM 输出损坏/未知项目 id → null', async () => {
    const { db } = setupDb()
    const s = seed(db)
    mk(db, s.lead.id, '目标项目')
    for (const out of ['不是json', '{"projectId": null, "confidence": 0.9}', '{"projectId": 999, "confidence": 0.9}', '{"projectId": "abc"}']) {
      const llm = { complete: async () => out }
      const r = await routeMessage(db, { text: 'x' }, { llm })
      expect(r.projectId).toBeNull()
    }
    db.close()
  })

  it('digest：项目/成员 404；LLM 输出损坏走降级叙事；建议缺字段被过滤', async () => {
    const { db } = setupDb()
    const s = seed(db)
    const p = mk(db, s.lead.id, 'D1')
    await expect(projectDigest(db, 999)).rejects.toThrow()
    await expect(personDigest(db, 999)).rejects.toThrow()
    const llm = { complete: async () => '完全不是 JSON' }
    const out = await projectDigest(db, p.id, { llm })
    expect(out.narrative).toContain('任务面')
    // 合法建议 + 两个非法建议（缺字段 / 未知任务）→ 只留 1 条
    const llm2 = {
      complete: async () => JSON.stringify({
        narrative: 'ok',
        suggestions: [
          { summary: '顺延', targetTaskId: p.tasks[0].id, targetField: 'plan_end_date', targetValue: '2026-12-01' },
          { summary: '缺字段', targetTaskId: p.tasks[0].id },
          { summary: '未知任务', targetTaskId: 999, targetField: 'plan_end_date', targetValue: '2026-12-01' },
        ],
      }),
    }
    const out2 = await projectDigest(db, p.id, { llm: llm2 })
    expect(out2.suggestions.length).toBe(1)
    db.close()
  })

  it('report：当日已发不重复（S18-4，v0.7 时点判断由 reportCron 调度接管）；明日到期任务出现在责任人日报', async () => {
    const { db } = setupDb()
    const s = seed(db)
    const first = await dailyReport(db, { force: false })
    expect(first.skipped).toBeUndefined()
    const skipped = await dailyReport(db, { force: false })
    expect(skipped.skipped).toBe(true)
    const p = mk(db, s.lead.id, 'R1')
    // S19：北京日口径——「明日」必须用 time.js 算（裸 toISOString 是 UTC，北京 00:00–08:00 窗口会错一天）
    const tomorrow = today(Date.now() + DAY_MS)
    updateTask(db, p.tasks[0].id, { planEndDate: tomorrow }, 1)
    await dailyReport(db, { force: true })
    const push = db.prepare(`SELECT * FROM pushes WHERE recipient_member_id = ? AND body LIKE '%明日到期%'`).get(s.lead.id)
    expect(push).toBeTruthy()
    db.close()
  })
})

describe('连接器补充分支（S3 抽取通道 / S22-6 上游失败回显）', () => {
  it('wecom：SDK 代理成功拉取与 HTTP 失败；健康检查通过', async () => {
    const real = globalThis.fetch
    globalThis.fetch = async (url) => {
      if (String(url).endsWith('/health')) return { ok: true }
      if (String(url).endsWith('/pull')) return { ok: true, json: async () => ({ messages: [{ id: 'w1', speakerId: 'wk_1', text: 'hi', ts: 1 }], nextCursor: 42 }) }
      return { ok: true }
    }
    const cfg = { corpId: 'c', secret: 's', privateKey: 'k', sdkUrl: 'http://sdk.local' }
    expect((await wecom.testConnection(cfg)).ok).toBe(true)
    const out = await wecom.fetchMessages(cfg, { groupKey: 'g' }, '0')
    expect(out.messages[0].id).toBe('w1')
    expect(out.nextCursor).toBe('42')
    globalThis.fetch = async () => ({ ok: false, status: 502 })
    await expect(wecom.fetchMessages(cfg, { groupKey: 'g' }, null)).rejects.toThrow('502')
    expect((await wecom.testConnection(cfg)).ok).toBe(false)
    globalThis.fetch = real
  })

  it('feishu：带游标拉取；畸形 content 回退原文；token 失败', async () => {
    const real = globalThis.fetch
    globalThis.fetch = async (url) => {
      const s = String(url)
      if (s.includes('tenant_access_token')) return { ok: true, json: async () => ({ code: 0, tenant_access_token: 't' }) }
      if (s.includes('tenant_access_token') === false && s.includes('/im/v1/messages')) {
        return { ok: true, json: async () => ({ code: 0, data: { has_more: false, items: [
          { message_id: 'x1', msg_type: 'text', create_time: '5000', sender: { id: 'ou' }, body: { content: '不是JSON' } },
        ] } }) }
      }
      return { ok: true, json: async () => ({}) }
    }
    const out = await feishu.fetchMessages({ appId: 'a', appSecret: 's' }, { groupKey: 'g' }, '4900')
    expect(out.messages[0].text).toBe('不是JSON')
    expect(out.nextCursor).toBe('5000')
    globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({ code: 0 }) })
    await expect(feishu.fetchMessages({ appId: 'a', appSecret: 's' }, { groupKey: 'g' }, null)).rejects.toThrow('500')
    globalThis.fetch = real
  })
})

describe('enums 兜底【工程防线】', () => {
  it('label 未知值原样返回；未知组抛错', () => {
    expect(label('priority', 'weird')).toBe('weird')
    expect(() => label('nope', 'x')).toThrow()
    expect(() => values('nope')).toThrow()
  })
})
