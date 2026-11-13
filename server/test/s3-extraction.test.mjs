import { describe, it, expect, afterAll } from 'vitest'
import { setupApp, loginCookie, authed } from './helpers.mjs'
import { upsertChannel, createMilestone } from '../engine/tasks.js'
import { ingestMessages, runExtraction, mapSpeaker, extractEvents } from '../brain/extract.js'
import { addEvent, confirmEvent } from '../engine/events.js'
import { getSetting } from '../engine/settings.js'
import { today, addDays } from '../db/time.js'

// PRD S3 — IM 抽取与分拣（专题渠道 / 通用群 LLM 分拣 / 身份映射 / 完成信号建议）

let ctx
afterAll(() => ctx?.db.close())

function fakeLlm(handler) {
  return { name: 'fake', complete: async (messages, opts) => handler(messages, opts) }
}

async function mkProject(name, leadId) {
  const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
  const res = await authed(ctx.app, cookie, 'POST', '/api/v1/projects', {
    name, templateCode: 'lianmai_365', leadMemberId: leadId, planEndDate: '2026-12-31',
  })
  return res.body
}

describe('S3 IM 抽取与分拣', () => {
  it('S3-1: 专题渠道只生成所属项目的事件', async () => {
    ctx = await setupApp()
    const a = await mkProject('客户A系统', ctx.members.lead.id)
    const b = await mkProject('客户B系统', ctx.members.dev.id)
    const ch = upsertChannel(ctx.db, { platform: 'feishu', groupKey: 'oc_a', channelType: 'dedicated', projectId: a.id })
    const baseA = ctx.db.prepare('SELECT COUNT(*) AS n FROM project_events WHERE project_id = ?').get(a.id).n
    const baseB = ctx.db.prepare('SELECT COUNT(*) AS n FROM project_events WHERE project_id = ?').get(b.id).n
    const llm = fakeLlm((messages) => {
      if (messages[0].content.includes('抽取器')) {
        return JSON.stringify({ events: [{ nature: 'record', eventType: 'progress', summary: '后端接口联调完成', confidence: 0.9 }] })
      }
      return JSON.stringify({ events: [] })
    })
    const stats = await ingestMessages(ctx.db, ch, [
      { id: 'om_1', speakerId: 'fs_zhang', text: '后端接口联调完成了', ts: Date.now() },
    ], { llm })
    expect(stats.events).toBe(1)
    const evA = ctx.db.prepare('SELECT COUNT(*) AS n FROM project_events WHERE project_id = ?').get(a.id).n
    const evB = ctx.db.prepare('SELECT COUNT(*) AS n FROM project_events WHERE project_id = ?').get(b.id).n
    expect(evA).toBe(baseA + 1)
    expect(evB).toBe(baseB)
  })

  it('S3-2: 通用群由 LLM 分拣；低置信进未分拣池不误挂', async () => {
    const a = await mkProject('客户C系统', ctx.members.lead.id)
    const general = upsertChannel(ctx.db, { platform: 'feishu', groupKey: 'oc_general', channelType: 'general' })
    const hi = fakeLlm((messages) => {
      const sys = messages[0].content
      if (sys.includes('分拣器')) return JSON.stringify({ projectId: a.id, confidence: 0.95 })
      return JSON.stringify({ events: [{ nature: 'record', eventType: 'progress', summary: 'C 系统进展', confidence: 0.9 }] })
    })
    const ok = await ingestMessages(ctx.db, general, [{ id: 'om_2', speakerId: 'fs_zhang', text: '客户C系统今天联调通过', ts: Date.now() }], { llm: hi })
    expect(ok.events).toBe(1)

    const lo = fakeLlm((messages) => {
      if (messages[0].content.includes('分拣器')) return JSON.stringify({ projectId: a.id, confidence: 0.1 })
      return JSON.stringify({ events: [] })
    })
    const before = ctx.db.prepare('SELECT COUNT(*) AS n FROM unrouted_messages').get().n
    const st2 = await ingestMessages(ctx.db, general, [{ id: 'om_3', speakerId: 'fs_li', text: '中午吃什么', ts: Date.now() }], { llm: lo })
    expect(st2.unrouted).toBe(1)
    const after = ctx.db.prepare('SELECT COUNT(*) AS n FROM unrouted_messages').get().n
    expect(after).toBe(before + 1)
    // 未误挂：该消息不产生项目事件
    const om3 = ctx.db.prepare(`SELECT COUNT(*) AS n FROM project_events WHERE raw_snapshot = '中午吃什么'`).get().n
    expect(om3).toBe(0)
  })

  it('S3-3: 未识别发言人归因「未识别」，不生成针对具体人的任务建议', async () => {
    const a = await mkProject('客户D系统', ctx.members.lead.id)
    const ch = upsertChannel(ctx.db, { platform: 'feishu', groupKey: 'oc_d', channelType: 'dedicated', projectId: a.id })
    // 身份映射：已知 id → 成员；未知 → null
    expect(mapSpeaker(ctx.db, 'feishu', 'fs_zhang').name).toBe('张三')
    expect(mapSpeaker(ctx.db, 'feishu', 'fs_unknown')).toBeNull()

    const llm = fakeLlm(() =>
      JSON.stringify({
        events: [
          { nature: 'record', eventType: 'progress', summary: '外部人员发言记录', confidence: 0.6 },
          { nature: 'suggestion', eventType: 'owner_change', summary: '把任务交给小王', targetTaskId: a.tasks[0].id, targetField: 'responsible_member_id', targetValue: String(ctx.members.key.id), confidence: 0.8 },
          { nature: 'suggestion', eventType: 'status_change', summary: '任务已完成', targetTaskId: a.tasks[1].id, targetField: 'status', targetValue: 'done', confidence: 0.9 },
        ],
      })
    )
    const stats = await ingestMessages(ctx.db, ch, [{ id: 'om_4', speakerId: 'fs_customer', text: '验收通过了，这块交给小王吧，另一个任务也完成了', ts: Date.now() }], { llm })
    // owner_change 针对具体人且发言人未识别 → 丢弃；status 建议保留为 pending
    expect(stats.suggestions).toBe(1)
    const ev = ctx.db.prepare(`SELECT * FROM project_events WHERE raw_snapshot LIKE '%验收通过%' ORDER BY id`).all()
    expect(ev.length).toBeGreaterThanOrEqual(2)
    expect(ev.every((e) => e.speaker_label === '未识别发言人')).toBe(true)
    expect(ev.some((e) => e.target_field === 'responsible_member_id')).toBe(false)
  })

  it('S3-4: 明确任务完成信号唯一匹配 → 直接生效；自动事件无人确认人，完成日取源消息北京日', async () => {
    const a = await mkProject('客户E系统', ctx.members.lead.id)
    const ch = upsertChannel(ctx.db, { platform: 'wecom', groupKey: 'wk_e', channelType: 'dedicated', projectId: a.id })
    const target = a.tasks.find((t) => t.title.includes('设备预检'))
    const sourceTs = Date.now() - 2 * 86400000
    ctx.db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(sourceTs - 1000, target.id)
    const llm = fakeLlm(() =>
      JSON.stringify({ events: [{ nature: 'suggestion', eventType: 'status_change', summary: '设备预检已完成', targetObject: 'task', targetTaskId: target.id, targetName: target.title, targetField: 'status', targetValue: 'done', confidence: 0.92 }] })
    )
    const stats = await ingestMessages(ctx.db, ch, [{ id: 'wm_1', speakerId: 'wk_wang', text: `${target.title}完成了，都检查过了`, ts: sourceTs }], { llm })
    expect(stats.suggestions).toBe(0)
    expect(stats.autoApplied).toBe(1)
    const evt = ctx.db.prepare(`SELECT * FROM project_events WHERE target_task_id = ? AND target_object = 'task' ORDER BY id DESC`).get(target.id)
    expect(evt.status).toBe('effective')
    expect(evt.decided_by).toBeNull()
    expect(evt.operation_key).toContain('wm_1')
    const after = ctx.db.prepare('SELECT status, actual_end_date FROM tasks WHERE id = ?').get(target.id)
    expect(after.status).toBe('done')
    expect(after.actual_end_date).toBe(today(sourceTs))
    expect(ctx.db.prepare(`SELECT COUNT(*) AS n FROM pushes WHERE title LIKE '%待确认建议%' AND related_project_id = ?`).get(a.id).n).toBe(0)
    const audit = ctx.db.prepare(`SELECT * FROM audit_logs WHERE action = 'extraction.apply' AND object_id = ?`).get(String(target.id))
    expect(audit).toBeTruthy()
  })

  it('S3-4: 明确里程碑达成信号 → 直接更新里程碑；同名任务与里程碑无法判定时只 pending 不猜', async () => {
    const a = await mkProject('客户E2系统', ctx.members.lead.id)
    const ch = upsertChannel(ctx.db, { platform: 'feishu', groupKey: 'oc_e2', channelType: 'dedicated', projectId: a.id })
    const ms = createMilestone(ctx.db, { projectId: a.id, name: '上线验收', planDate: '2026-12-20' }, ctx.members.lead.id)
    const sourceTs = Date.now() - 86400000
    ctx.db.prepare('UPDATE milestones SET updated_at = ? WHERE id = ?').run(sourceTs - 1000, ms.id)
    const llm = fakeLlm(() => JSON.stringify({ events: [{ nature: 'suggestion', eventType: 'status_change', summary: '里程碑「上线验收」已达成', targetObject: 'milestone', targetTaskId: ms.id, targetName: '上线验收', targetField: 'status', targetValue: 'met', confidence: 0.95 }] }))
    const stats = await ingestMessages(ctx.db, ch, [{ id: 'om_ms_auto', speakerId: 'fs_zhang', text: '里程碑「上线验收」已经完成', ts: sourceTs }], { llm })
    expect(stats.autoApplied).toBe(1)
    const after = ctx.db.prepare('SELECT status, actual_date FROM milestones WHERE id = ?').get(ms.id)
    expect(after).toEqual({ status: 'met', actual_date: today(sourceTs) })

    const target = a.tasks[0]
    const duplicate = createMilestone(ctx.db, { projectId: a.id, name: target.title, planDate: '2026-12-25' }, ctx.members.lead.id)
    const ambiguousLlm = fakeLlm(() => JSON.stringify({ events: [{ nature: 'suggestion', eventType: 'status_change', summary: `「${target.title}」已完成`, targetObject: 'task', targetTaskId: target.id, targetName: target.title, targetField: 'status', targetValue: 'done', confidence: 0.96 }] }))
    const pending = await ingestMessages(ctx.db, ch, [{ id: 'om_ambiguous', speakerId: 'fs_zhang', text: `「${target.title}」完成了`, ts: Date.now() }], { llm: ambiguousLlm })
    expect(pending.autoApplied).toBe(0)
    expect(pending.suggestions).toBe(1)
    expect(ctx.db.prepare('SELECT status FROM tasks WHERE id = ?').get(target.id).status).toBe('todo')
    expect(ctx.db.prepare('SELECT status FROM milestones WHERE id = ?').get(duplicate.id).status).toBe('planned')
    const evt = ctx.db.prepare(`SELECT * FROM project_events WHERE source_ref = 'om_ambiguous'`).get()
    expect(evt.status).toBe('pending')
    expect(JSON.parse(evt.target_candidates || '[]')).toHaveLength(2)
  })

  it('S3-4: 原话明确类型与唯一名称冲突时不张冠李戴，只 pending', async () => {
    const a = await mkProject('客户E3系统', ctx.members.lead.id)
    const ch = upsertChannel(ctx.db, { platform: 'feishu', groupKey: 'oc_e3', channelType: 'dedicated', projectId: a.id })
    const target = a.tasks[0]
    const llm = fakeLlm(() => JSON.stringify({ events: [{ nature: 'suggestion', eventType: 'status_change', summary: `里程碑「${target.title}」已完成`, targetObject: 'task', targetTaskId: target.id, targetName: target.title, targetField: 'status', targetValue: 'done', confidence: 0.99 }] }))
    const stats = await ingestMessages(ctx.db, ch, [{ id: 'om_type_conflict', speakerId: 'fs_zhang', text: `里程碑「${target.title}」已经完成`, ts: Date.now() }], { llm })
    expect(stats.autoApplied).toBe(0)
    expect(stats.suggestions).toBe(1)
    expect(ctx.db.prepare('SELECT status FROM tasks WHERE id = ?').get(target.id).status).toBe('todo')
  })

  it('S3-5: 【已废弃 v0.72】采纳率告警已裁撤：低于旧阈值不再推送告警、thresholds 无 acceptanceAlarm 键', async () => {
    // K51：告警整体移除。造 10 条建议（2 生效 / 8 驳回 → 20%，低于旧告警线 70%）验证不再告警
    // v0.91 附带修复（日期炸弹）：targetValue 原写死 '2026-11-11'——今天越过该日后面向 2026-12-31 倒排的
    // 任务 plan_start > 2026-11-11，confirmEvent 撞「计划开始日不能晚于计划结束日」400。改动态未来日
    //（addDays(today(), 400)，K16：测试日期推算一律走 db/time）。
    const a = await mkProject('客户F系统', ctx.members.lead.id)
    const farFuture = addDays(today(), 400)
    for (let i = 0; i < 10; i++) {
      const e = addEvent(ctx.db, {
        projectId: a.id, nature: 'suggestion', eventType: 'suggestion', summary: `建议${i}`,
        targetTaskId: a.tasks[0].id, targetField: 'plan_end_date', targetValue: farFuture, generatedBy: 'extraction',
      })
      if (i < 2) confirmEvent(ctx.db, e.id, ctx.members.lead.id)
      else {
        ctx.db.prepare(`UPDATE project_events SET status = 'rejected' WHERE id = ?`).run(e.id)
      }
    }
    const res = await runExtraction(ctx.db, {}, { llm: fakeLlm(() => JSON.stringify({ events: [] })) })
    expect(res.channels.find((c) => c.acceptanceAlarm)).toBeFalsy()
    expect(ctx.db.prepare(`SELECT * FROM pushes WHERE push_type = 'alert' AND title LIKE '%采纳率%'`).get()).toBeFalsy()
    expect(getSetting(ctx.db, 'thresholds').acceptanceAlarm).toBeUndefined()
  })

  it('S3-6: 新建渠道绑定 cursor=绑定时刻（首拉不回灌）；改名/改绑不重置游标', async () => {
    const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const a = await mkProject('客户G系统', ctx.members.lead.id)
    const before = Math.floor(Date.now() / 1000)
    const created = await authed(ctx.app, cookie, 'POST', '/api/v1/channels', {
      platform: 'feishu', groupKey: 'oc_cursor_g', channelType: 'dedicated', projectId: a.id,
    })
    expect(created.status).toBe(201)
    // 游标=绑定时刻：连接器 start = cursor+1，首次抽取只处理绑定之后的聊天
    expect(Number(created.body.cursor)).toBeGreaterThanOrEqual(before)
    expect(Number(created.body.cursor)).toBeLessThanOrEqual(Math.floor(Date.now() / 1000))
    // 通用群同语义
    const general = await authed(ctx.app, cookie, 'POST', '/api/v1/channels', {
      platform: 'feishu', groupKey: 'oc_cursor_general', channelType: 'general',
    })
    expect(general.status).toBe(201)
    expect(Number(general.body.cursor)).toBeGreaterThanOrEqual(before)

    // 已绑定渠道更新（改名+改绑到另一项目）：游标保留，不重置、不回灌
    const b = await mkProject('客户H系统', ctx.members.dev.id)
    const updated = await authed(ctx.app, cookie, 'POST', '/api/v1/channels', {
      platform: 'feishu', groupKey: 'oc_cursor_g', name: '改名并改绑', channelType: 'dedicated', projectId: b.id,
    })
    expect(updated.status).toBe(201)
    expect(updated.body.projectId).toBe(b.id)
    expect(Number(updated.body.cursor)).toBe(Number(created.body.cursor))
  })

  // S3-7（v0.88，K74）：抽取提示词任务状态信号优先——完成类必须产 suggestion、record 不替代变更、
  // 未点名对象推断归挂。提示词是分类行为唯一真相源（代码无关键词兜底、LLM 行为不进 CI），用契约测试钉住关键指令。
  it('S3-7: 抽取系统提示任务状态信号优先——完成同义词枚举、不得只产 record、未点名对象推断归挂、targetName 回写清单标题', async () => {
    ctx = await setupApp()
    const a = await mkProject('客户I系统', ctx.members.lead.id)
    let sys = ''
    const llm = fakeLlm((messages) => {
      sys = messages[0].content
      return JSON.stringify({ events: [] })
    })
    await extractEvents(llm, ctx.db, a.id, [{ speakerName: '张三', text: '设备预检完成了' }])
    expect(sys).toContain('抽取器')
    // ① 状态信号优先于纯记录判定
    expect(sys).toMatch(/先[^。]*?(状态|变更)信号|状态信号优先/)
    // ② 完成口语同义词枚举（线上误判主因：口语完成被判「不够明确」）
    expect(sys).toContain('搞定了')
    expect(sys).toContain('上线了')
    // ③ 完成必须产 suggestion，record 归档不得替代状态变更
    expect(sys).toMatch(/不得只产 record/)
    // ④ 「基本完成/还剩」防误报护栏
    expect(sys).toMatch(/基本完成|差不多了/)
    // ⑤ 未点名对象结合清单与发言人名下任务推断归挂（群聊大多围绕任务）
    expect(sys).toMatch(/未点名|没有点名/)
    expect(sys).toContain('推断')
    // ⑥ targetName 回写清单完整标题（消歧器按标题匹配，原话简称照抄天然错位）
    expect(sys).toMatch(/完整标题/)
  })

  it('S3-7: 完成消息 record+suggestion 并存——过程摘要归档任务时间线且状态自动生效（两件事并存契约）', async () => {
    const a = await mkProject('客户I2系统', ctx.members.lead.id)
    const ch = upsertChannel(ctx.db, { platform: 'feishu', groupKey: 'oc_i2', channelType: 'dedicated', projectId: a.id })
    const target = a.tasks.find((t) => t.title.includes('设备预检'))
    const sourceTs = Date.now() - 2 * 86400000
    ctx.db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(sourceTs - 1000, target.id)
    const llm = fakeLlm(() => JSON.stringify({
      events: [
        { nature: 'record', eventType: 'progress', summary: '设备预检收尾，全部检查项通过', targetTaskId: target.id, confidence: 0.9 },
        { nature: 'suggestion', eventType: 'status_change', summary: '设备预检已完成', targetObject: 'task', targetTaskId: target.id, targetName: target.title, targetField: 'status', targetValue: 'done', confidence: 0.92 },
      ],
    }))
    const stats = await ingestMessages(ctx.db, ch, [{ id: 'om_i2', speakerId: 'fs_zhang', text: `${target.title}完成了，都检查过了`, ts: sourceTs }], { llm })
    // 状态变更自动生效（S3-4 闸门口径），任务落 done
    expect(stats.autoApplied).toBe(1)
    expect(ctx.db.prepare('SELECT status FROM tasks WHERE id = ?').get(target.id).status).toBe('done')
    // 过程 record 同步归档任务时间线（S56），两件事并存互不替代
    expect(ctx.db.prepare(`SELECT COUNT(*) AS n FROM task_records WHERE task_id = ? AND content LIKE '%全部检查项通过%'`).get(target.id).n).toBe(1)
  })

  // v0.91【工程防线】线上事故主因：提示词对象清单是 "#306 标题" 格式，模型（GLM-5.3-Flash 实测）回显
  // "targetTaskId":"#306"（带 # 的字符串），裸 Number() 解析得 NaN → suggestion 候选 100% 静默丢弃。
  it('【工程防线】 targetTaskId 带 # 前缀字符串（"#<id>"，模型回显清单格式）→ 建议照常解析并自动生效（v0.91）', async () => {
    const a = await mkProject('客户J系统', ctx.members.lead.id)
    const ch = upsertChannel(ctx.db, { platform: 'feishu', groupKey: 'oc_j', channelType: 'dedicated', projectId: a.id })
    const target = a.tasks.find((t) => t.title.includes('设备预检'))
    const sourceTs = Date.now() - 2 * 86400000
    ctx.db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(sourceTs - 1000, target.id)
    const llm = fakeLlm(() => JSON.stringify({
      events: [{ nature: 'suggestion', eventType: 'status_change', summary: '设备预检已完成', targetObject: 'task', targetTaskId: `#${target.id}`, targetName: target.title, targetField: 'status', targetValue: 'done', confidence: 0.95, msgIndex: 0 }],
    }))
    const stats = await ingestMessages(ctx.db, ch, [{ id: 'om_j1', speakerId: 'fs_zhang', text: `${target.title}完成了`, ts: sourceTs }], { llm })
    expect(stats.autoApplied).toBe(1)
    expect(stats.suggestions).toBe(0)
    expect(ctx.db.prepare('SELECT status FROM tasks WHERE id = ?').get(target.id).status).toBe('done')
    const evt = ctx.db.prepare(`SELECT * FROM project_events WHERE source_ref = 'om_j1'`).get()
    expect(evt.status).toBe('effective')
    expect(evt.target_task_id).toBe(target.id)
  })
})
