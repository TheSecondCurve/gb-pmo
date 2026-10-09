import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import crypto from 'node:crypto'
import { setupApp, loginCookie, authed } from './helpers.mjs'
import { BOT_SECRET as SECRET, scriptedLlm, makeRecorder, makeMsgFactory, mkProject } from './bot-kit.mjs'
import { upsertChannel, updateTask } from '../engine/tasks.js'
import { closeProject } from '../engine/projects.js'
import { ingestMessages } from '../brain/extract.js'
import { handleBotEvent, handleCardAction } from '../brain/bot/command.js'
import { runReadOnlyQuery } from '../agent/sqlGuard.js'
import { runWriteTool } from '../brain/bot/tools.js'
import { runAgentLoop } from '../brain/bot/agent.js'
import { getSetting, setSetting } from '../engine/settings.js'

// PRD S20 — 机器人指令通道·写路径面：直改回执（v0.46/K25）/ 记录型生效 / 护栏与有界循环对抗 / 审计·限额·去重。

let ctx
const recorder = makeRecorder()
const { p2p, group } = makeMsgFactory()

beforeAll(async () => {
  ctx = await setupApp()
})
afterAll(() => ctx?.db.close())

describe('S20 机器人指令通道 — 写路径（直改回执，v0.46/K25）', () => {
  it('S20-2: 口述变更直改生效并回执——落建议型事件立即以发令人身份生效，不再出确认卡', async () => {
    const p = await mkProject(ctx, '客户B系统', ctx.members.lead.id)
    const taskId = ctx.db.prepare('SELECT id FROM tasks WHERE project_id = ? ORDER BY id').get(p.id).id
    const { llm } = scriptedLlm(
      JSON.stringify({ action: 'write', kind: 'suggest_event', payload: { targetTaskId: taskId, targetField: 'status', targetValue: 'done' } })
    )
    const rec = recorder()
    const out = await handleBotEvent(ctx.db, p2p('fs_zhang', `把任务 #${taskId} 标为完成`), { llm, send: rec.send, secret: SECRET })
    expect(out.result).toBe('replied')
    expect(rec.sent[0].text).toContain('已生效')
    expect(rec.sent[0].card).toBeUndefined()
    const evtRow = ctx.db.prepare('SELECT * FROM project_events WHERE target_task_id = ? ORDER BY id DESC').get(taskId)
    expect(evtRow.nature).toBe('suggestion')
    expect(evtRow.status).toBe('effective')
    expect(evtRow.decided_by).toBe(ctx.members.lead.id) // 发令人即生效人
    expect(evtRow.generated_by).toBe('agent')
    expect(evtRow.source_platform).toBe('feishu')
    expect(evtRow.speaker_member_id).toBe(ctx.members.lead.id)
    expect(ctx.db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId).status).toBe('done')
    // 直改后无待确认事项 → 不再推送
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM pushes WHERE related_project_id = ?').get(p.id).n).toBe(0)
  })

  it('S20-2: 一条指令多个变更走 items 批量——逐条独立生效，汇总回执单列失败原因', async () => {
    const p = await mkProject(ctx, '客户B2系统', ctx.members.lead.id)
    const [t1, t2] = ctx.db.prepare('SELECT id FROM tasks WHERE project_id = ? ORDER BY id LIMIT 2').all(p.id).map((r) => r.id)
    const { llm } = scriptedLlm(
      JSON.stringify({
        action: 'write', kind: 'suggest_event',
        payload: {
          items: [
            { targetTaskId: t1, targetField: 'status', targetValue: 'done' },
            { targetTaskId: t2, targetField: 'status', targetValue: 'doing' },
            { targetTaskId: 999999, targetField: 'status', targetValue: 'done' },
          ],
        },
      })
    )
    const rec = recorder()
    const out = await handleBotEvent(ctx.db, p2p('fs_zhang', '把前两个任务一个标完成一个标进行中'), { llm, send: rec.send, secret: SECRET })
    expect(out.result).toBe('replied')
    const text = rec.sent[0].text
    expect(text).toContain('已生效 2 项')
    expect(text).toContain('失败 1 项')
    expect(ctx.db.prepare('SELECT status FROM tasks WHERE id = ?').get(t1).status).toBe('done')
    expect(ctx.db.prepare('SELECT status FROM tasks WHERE id = ?').get(t2).status).toBe('doing')
    // 两条生效留痕（decided_by=发令人）；坏 id 不落事件不阻塞其余
    const evts = ctx.db.prepare(`SELECT * FROM project_events WHERE project_id = ? AND nature = 'suggestion' ORDER BY id`).all(p.id)
    expect(evts).toHaveLength(2)
    expect(evts.every((e) => e.status === 'effective' && e.decided_by === ctx.members.lead.id)).toBe(true)
  })

  it('S20-3: 口述登记记录型事件自动生效，归因发令人', async () => {
    const p = await mkProject(ctx, '客户C系统', ctx.members.lead.id)
    const { llm } = scriptedLlm(
      JSON.stringify({ action: 'write', kind: 'record_event', payload: { projectId: p.id, eventType: 'risk', summary: '客户环境未就绪，验收可能顺延' } })
    )
    const rec = recorder()
    const evt = p2p('fs_zhang', '登记风险：客户环境未就绪，验收可能顺延')
    const out = await handleBotEvent(ctx.db, evt, { llm, send: rec.send, secret: SECRET })
    expect(out.result).toBe('replied')
    expect(rec.sent[0].text).toContain('已登记')
    const row = ctx.db.prepare('SELECT * FROM project_events WHERE project_id = ? ORDER BY id DESC').get(p.id)
    expect(row.nature).toBe('record')
    expect(row.status).toBe('effective')
    expect(row.event_type).toBe('risk')
    expect(row.speaker_label).toBe('张三')
    expect(row.raw_snapshot).toContain('客户环境未就绪')
    expect(row.source_ref).toBe(evt.messageId)
  })
})

describe('S20 机器人指令通道 — 对抗与边界（护栏/循环/写校验）', () => {
  it('query 工具护栏与 Agent SQL 端点同源：DDL/凭据列/sessions/裸 date(now)/写语句全拒', async () => {
    const rejects = (sql, word) => {
      try {
        runReadOnlyQuery(ctx.db, sql)
        throw new Error(`应当被拒: ${sql}`)
      } catch (e) {
        expect(e.statusCode).toBeDefined()
        expect(e.message).toContain(word)
      }
    }
    rejects('DROP TABLE members', 'DDL/PRAGMA')
    rejects('SELECT password_hash FROM members LIMIT 1', '凭据列')
    rejects("SELECT * FROM sessions", 'sessions')
    rejects("SELECT date('now')", 'BJ_TODAY')
    rejects(`INSERT INTO pushes (push_type) VALUES ('test')`, '只读查询')
    rejects('UPDATE tasks SET status = \'done\'', '只读查询')
    // 注释前缀不能绕过：-- 注释 + 写语句仍拒
    rejects('-- harmless\nDELETE FROM tasks', '只读查询')
    // 合法只读放行（含 BJ_TODAY 与注释前缀 SELECT）
    const ok = runReadOnlyQuery(ctx.db, `-- 查一下\nSELECT COUNT(*) AS n FROM tasks WHERE plan_end_date < BJ_TODAY()`)
    expect(ok.count).toBe(1)
  })

  it('agent 循环边界：坏 JSON 降级、未知动作纠偏、查询超预算、轮数耗尽、clarify 归类', async () => {
    const noop = async () => '工具结果'
    // 坏 JSON（破碎、以 { 开头）→ 降级话术（非 JSON 散文的透出见 S20-21 用例）
    const r1 = await runAgentLoop({ llm: { name: 'f', complete: async () => '{"action":"reply","text":"半截' }, systemPrompt: 's', userText: 'u', execTool: noop })
    expect(r1.result).toBe('replied')
    expect(r1.text).toContain('没听懂')
    // 未知动作 → 纠偏后 reply
    const r2 = await runAgentLoop({
      llm: { name: 'f', complete: async (m) => (m.length <= 2 ? '{"action":"dance"}' : '{"action":"reply","text":"好了"}') },
      systemPrompt: 's', userText: 'u', execTool: noop,
    })
    expect(r2.text).toBe('好了')
    // 查询超预算：第 9 次 query 被拦并要求直接回复
    let q = 0
    const r3 = await runAgentLoop({
      llm: {
        name: 'f',
        complete: async (m) => (m[m.length - 1].content.includes('上限') ? '{"action":"reply","text":"查够了"}' : '{"action":"query","sql":"SELECT 1"}'),
      },
      systemPrompt: 's', userText: 'u', execTool: async () => { q += 1; return '[]' }, maxTurns: 12,
    })
    expect(q).toBe(8)
    expect(r3.text).toBe('查够了')
    // 轮数耗尽 → 兜底话术
    const r4 = await runAgentLoop({
      llm: { name: 'f', complete: async () => '{"action":"query","sql":"SELECT 1"}' },
      systemPrompt: 's', userText: 'u', execTool: noop, maxTurns: 3,
    })
    expect(r4.text).toContain('太多')
    // clarify → clarified
    const r5 = await runAgentLoop({ llm: { name: 'f', complete: async () => '{"action":"clarify","text":"你指哪个项目？"}' }, systemPrompt: 's', userText: 'u', execTool: noop })
    expect(r5.result).toBe('clarified')
  })

  // S20-21（v0.38）LLM 偶发不守 JSON 协议的分层降级：线上实测（真实凭证+真实系统提示全链路复现）
  // GLM-5.3-Flash 多轮工具调用后想向用户澄清时直接输出中文散文（内容正确、就是要给用户看的话），
  // 此前 parseJsonLoose 失败一律回「没听懂」——用户收到驴唇不对马嘴的回复。
  it('S20-21: 非 JSON 散文/缺 action 的半成品 JSON 透出为答复；空输出与破碎 JSON 维持没听懂', async () => {
    const noop = async () => '工具结果'
    // ① 纯散文（线上复现原文形态：多轮查询后向用户提问澄清）→ 原样透出
    const prose = '已核对现有配置，起草立项提议前需确认几点：\n\n1. 项目类型：当前启用的类型有 365连麦、1v1商业咨询…\n2. 牵头人：默认写斯斯（id=1）？\n\n确认后我立即起草立项提议。'
    const r1 = await runAgentLoop({ llm: { name: 'f', complete: async () => prose }, systemPrompt: 's', userText: 'u', execTool: noop })
    expect(r1.kind).toBe('reply')
    expect(r1.result).toBe('replied')
    expect(r1.text).toBe(prose)
    // ② 缺 action 但带非空 text 的半成品 JSON → 透出 text
    const r2 = await runAgentLoop({ llm: { name: 'f', complete: async () => '{"text":"建议先确认项目类型再立项。"}' }, systemPrompt: 's', userText: 'u', execTool: noop })
    expect(r2.result).toBe('replied')
    expect(r2.text).toBe('建议先确认项目类型再立项。')
    // ③ 空输出 → 没听懂
    const r3 = await runAgentLoop({ llm: { name: 'f', complete: async () => '' }, systemPrompt: 's', userText: 'u', execTool: noop })
    expect(r3.text).toContain('没听懂')
    // ④ 破碎 JSON（以 { 开头解析失败）→ 没听懂
    const r4 = await runAgentLoop({ llm: { name: 'f', complete: async () => '{"action":"query","sql":"SELECT' }, systemPrompt: 's', userText: 'u', execTool: noop })
    expect(r4.text).toContain('没听懂')
    // ⑤ 缺 action 且无 text 的 JSON → 没听懂（不透出对象字符串）
    const r5 = await runAgentLoop({ llm: { name: 'f', complete: async () => '{"foo":1}' }, systemPrompt: 's', userText: 'u', execTool: noop })
    expect(r5.text).toContain('没听懂')
    // ⑥ 透出发生在工具调用之后时 turns/queries 照实计数
    let n = 0
    const r6 = await runAgentLoop({
      llm: { name: 'f', complete: async () => (n++ === 0 ? '{"action":"query","sql":"SELECT 1"}' : prose) },
      systemPrompt: 's', userText: 'u', execTool: async () => '[{"n":1}]',
    })
    expect(r6.text).toBe(prose)
    expect(r6.turns).toBe(2)
    expect(r6.queries).toBe(1)
  })

  it('S20-21: 私聊全链路——首轮查询后模型散文澄清，用户收到澄清原文而非「没听懂」；系统提示含裸文本禁令', async () => {
    const prose = '起草立项提议前需确认：1. 项目类型选哪个？2. 牵头人默认是你吗？'
    const { llm, calls } = scriptedLlm(
      JSON.stringify({ action: 'query', sql: 'SELECT id, code, name FROM project_types WHERE status = \'active\'' }),
      prose,
    )
    const rec = recorder()
    // 独立 chatId：避免本用例消息混入 oc_p2p 共享会话历史、干扰其他用例的上下文断言
    const evt = { ...p2p('fs_zhang', '新建一个项目：问问斯斯上线前准备项目'), chatId: 'oc_s2021' }
    const out = await handleBotEvent(ctx.db, evt, { llm, send: rec.send, secret: SECRET })
    expect(out.result).toBe('replied')
    expect(rec.sent[0].text).toBe(prose)
    // 系统提示加固：裸文本禁令进协议头
    expect(calls[0][0].content).toContain('不输出裸文本')
  })

  it('写分发校验：非法载荷一律拒绝并给中文理由，不落库', async () => {
    const p = await mkProject(ctx, '客户H系统', ctx.members.lead.id)
    const taskId = ctx.db.prepare('SELECT id FROM tasks WHERE project_id = ? ORDER BY id').get(p.id).id
    const member = { id: ctx.members.lead.id, name: '张三', role: 'member' }
    const evt = { chatType: 'p2p', messageId: 'om_w', text: '原始消息', ts: Date.now() }
    const refuse = async (kind, payload, word) => {
      const r = await runWriteTool(ctx.db, { kind, payload }, { member, evt })
      expect(r.type).toBe('refused')
      expect(r.text).toContain(word)
    }
    await refuse('record_event', {}, 'projectId')
    await refuse('record_event', { projectId: p.id, eventType: 'progress' }, 'summary')
    await refuse('record_event', { projectId: 999999, eventType: 'progress', summary: 'x' }, 'projectId')
    await refuse('record_event', { projectId: p.id, eventType: '不存在的类型', summary: 'x' }, '操作被拒绝')
    await refuse('suggest_event', { targetTaskId: 999999, targetField: 'status', targetValue: 'done' }, 'targetTaskId')
    await refuse('suggest_event', { targetTaskId: taskId, targetField: 'nope', targetValue: 'x' }, 'targetField')
    await refuse('suggest_event', { targetTaskId: taskId, targetField: 'plan_end_date', targetValue: '明天' }, 'YYYY-MM-DD')
    await refuse('suggest_event', { targetTaskId: taskId, targetField: 'responsible_member_id', targetValue: 999 }, '在职成员')
    await refuse('suggest_event', { targetTaskId: taskId, targetField: 'status', targetValue: '完成后', projectId: p.id + 1 }, '任务不属于')
    await refuse('bind_channel', { projectId: p.id }, '群聊') // 私聊里不可登记
    await refuse('trigger', { name: 'put_setting' }, '仅支持') // 白名单外（配置类不开放给机器人）
    await refuse('magic', {}, '不支持的写类型')
    // 权限：普通成员（非牵头人/管理员）bind_channel 在群里 → refused_permission
    const nobody = { id: ctx.members.dev.id, name: '李四', role: 'member' }
    const denied = await runWriteTool(ctx.db, { kind: 'bind_channel', payload: { projectId: p.id } }, { member: nobody, evt: { ...evt, chatType: 'group' } })
    expect(denied.result).toBe('refused_permission')
  })

  it('trigger 工具走 action 注册表（与 HTTP 端点同构）', async () => {
    const r = await runWriteTool(ctx.db, { kind: 'trigger', payload: { name: 'generate_person_digest', params: { memberId: ctx.members.lead.id } } },
      { member: { id: ctx.members.lead.id, name: '张三', role: 'member' }, evt: { chatType: 'p2p' } })
    expect(r.type).toBe('receipt')
    expect(r.text).toContain('generate_person_digest')
  })

  it('卡片回调边界：未知动作 / 无密钥 / 存量群登记卡项目已删（v0.46 兼容保留）', async () => {
    const unknown = await handleCardAction(ctx.db, { operatorOpenId: 'fs_zhang', value: { a: 'magic' }, chatId: 'c' }, { send: recorder().send, secret: SECRET })
    expect(unknown.result).toBe('error')
    const noSecret = await handleCardAction(ctx.db, { operatorOpenId: 'fs_zhang', value: { a: 'confirm', e: '1', s: 'x' }, chatId: 'c' }, { send: recorder().send, secret: '' })
    expect(noSecret.text).toContain('签名密钥')
    // 存量 bind 卡（v0.46 前发出）点按仍走兼容分支：项目已删 → 明确提示
    const bindValue = { a: 'bind', p: '999999', g: 'oc_x', n: '', s: crypto.createHmac('sha256', SECRET).update('bind:oc_x:999999').digest('hex').slice(0, 16) }
    const gone = await handleCardAction(ctx.db, {
      operatorOpenId: 'fs_zhang',
      value: bindValue,
      chatId: 'c',
    }, { send: recorder().send, secret: SECRET })
    expect(gone.text).toContain('项目已不存在')
  })
})

describe('S20 机器人指令通道 — 审计、限额与去重', () => {
  it('S20-5: message_id 去重 + 每日限额（北京日）', async () => {
    // 先清李四当日指令行，让限额从 0 起算（验证配额语义本身）
    ctx.db.prepare('DELETE FROM bot_commands WHERE member_id = ?').run(ctx.members.dev.id)
    setSetting(ctx.db, 'im.feishu', { commandQuotaPerDay: 1 }, 1)
    const { llm } = scriptedLlm(JSON.stringify({ action: 'reply', text: '好的' }))
    const rec = recorder()
    const evt = p2p('fs_li', '在吗')
    const out1 = await handleBotEvent(ctx.db, evt, { llm, send: rec.send, secret: SECRET })
    expect(out1.result).toBe('replied')
    // 同一 message_id 重复投递 → 忽略，无二次回复
    const out1b = await handleBotEvent(ctx.db, evt, { llm, send: rec.send, secret: SECRET })
    expect(out1b.result).toBe('ignored_dedup')
    expect(rec.sent).toHaveLength(1)
    // 限额=1：第二条拒绝
    const out2 = await handleBotEvent(ctx.db, p2p('fs_li', '再问一条'), { llm: scriptedLlm().llm, send: rec.send, secret: SECRET })
    expect(out2.result).toBe('refused_quota')
    expect(rec.sent[1].text).toContain('额度')
    setSetting(ctx.db, 'im.feishu', { commandQuotaPerDay: 50 }, 1)
    expect(getSetting(ctx.db, 'im.feishu').commandQuotaPerDay).toBe(50)
  })

  it('S20-5: 限额口径只计 IM 面——web 会话消息不烧飞书额度（v0.25 对称）', async () => {
    // 清李四当日指令行，从 0 起算
    ctx.db.prepare('DELETE FROM bot_commands WHERE member_id = ?').run(ctx.members.dev.id)
    setSetting(ctx.db, 'im.feishu', { commandQuotaPerDay: 2 }, 1)
    // 真实路径造 3 条 web 指令审计行（LLM 未配置 → no_llm，审计行照落）
    const cookie = await loginCookie(ctx.app, 'lisi', 'pass-123456')
    const sid = (await authed(ctx.app, cookie, 'POST', '/api/v1/chat/sessions', {})).body.id
    for (let i = 0; i < 3; i++) {
      await authed(ctx.app, cookie, 'POST', `/api/v1/chat/sessions/${sid}/messages`, { text: `web 第 ${i + 1} 条` })
    }
    expect(ctx.db.prepare(`SELECT COUNT(*) AS n FROM bot_commands WHERE member_id = ? AND platform = 'web' AND kind = 'command'`).get(ctx.members.dev.id).n).toBe(3)
    // 飞书第 1 条：若口径未修（web 也计入），3 + 1 > 2 会被拒
    const { llm } = scriptedLlm(JSON.stringify({ action: 'reply', text: '好的' }))
    const rec = recorder()
    const out = await handleBotEvent(ctx.db, p2p('fs_li', '在吗'), { llm, send: rec.send, secret: SECRET })
    expect(out.result).toBe('replied')
    setSetting(ctx.db, 'im.feishu', { commandQuotaPerDay: 50 }, 1)
  })

  it('S20-10: 定时抽取跳过机器人已处理的消息（不双入库）', async () => {
    const p = await mkProject(ctx, '客户G系统', ctx.members.lead.id)
    const ch = upsertChannel(ctx.db, { platform: 'feishu', groupKey: 'oc_g_sys', channelType: 'dedicated', projectId: p.id })
    // 机器人已把这条消息处理成记录型事件
    const { llm } = scriptedLlm(
      JSON.stringify({ action: 'write', kind: 'record_event', payload: { projectId: p.id, eventType: 'risk', summary: '联调阻塞' } })
    )
    const evt10 = group('fs_zhang', 'oc_g_sys', '@bot 登记风险：联调阻塞', { chatTitle: 'G群' })
    const out = await handleBotEvent(ctx.db, evt10, { llm, send: recorder().send, secret: SECRET })
    expect(out.result).toBe('replied')
    const before = ctx.db.prepare('SELECT COUNT(*) AS n FROM project_events WHERE project_id = ?').get(p.id).n
    // 同一 message_id 走定时抽取 → 跳过（即使抽取器想产事件）
    const extractLlm = { name: 'fake', complete: async () => JSON.stringify({ events: [{ nature: 'record', eventType: 'progress', summary: '重复', confidence: 0.9 }] }) }
    const stats = await ingestMessages(ctx.db, ch, [{ id: evt10.messageId, speakerId: 'fs_zhang', text: '@bot 登记风险：联调阻塞', ts: Date.now() }], { llm: extractLlm })
    expect(stats.botProcessed).toBe(1)
    expect(stats.events).toBe(0)
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM project_events WHERE project_id = ?').get(p.id).n).toBe(before)
  })
})

describe('S20-2/S20-3 写路径分支（工具层：日期/责任人建议直改、终态只读、快照降级）', () => {
  it('日期与责任人建议直改生效并回执中文摘要；终态项目任务建议拒绝；无原始消息时快照为 null', async () => {
    const p = await mkProject(ctx, '分支项目', ctx.members.lead.id)
    const taskId = ctx.db.prepare('SELECT id FROM tasks WHERE project_id = ? ORDER BY id').get(p.id).id
    const member = { id: ctx.members.lead.id, name: '张三', role: 'member' }
    const evt = { chatType: 'p2p', messageId: 'om_branch', text: '口述', ts: Date.now() }

    // 日期建议：合法 YYYY-MM-DD → 直改生效，回执带日期，事件 effective（decided_by=发令人）
    const d = await runWriteTool(ctx.db, { kind: 'suggest_event', payload: { targetTaskId: taskId, targetField: 'plan_end_date', targetValue: '2026-12-31' } }, { member, evt })
    expect(d.type).toBe('receipt')
    expect(d.text).toContain('2026-12-31')
    expect(ctx.db.prepare('SELECT plan_end_date FROM tasks WHERE id = ?').get(taskId).plan_end_date).toBe('2026-12-31')
    const dEvt = ctx.db.prepare('SELECT status, decided_by FROM project_events WHERE target_task_id = ? ORDER BY id DESC').get(taskId)
    expect(dEvt.status).toBe('effective')
    expect(dEvt.decided_by).toBe(member.id)

    // 责任人建议：在职成员 id → 直改生效，回执带人名
    const o = await runWriteTool(ctx.db, { kind: 'suggest_event', payload: { targetTaskId: taskId, targetField: 'responsible_member_id', targetValue: ctx.members.dev.id } }, { member, evt })
    expect(o.type).toBe('receipt')
    expect(o.text).toContain('李四')
    expect(ctx.db.prepare('SELECT responsible_member_id FROM tasks WHERE id = ?').get(taskId).responsible_member_id).toBe(ctx.members.dev.id)

    // 非法枚举值被引擎 400 接住 → refused（非 403 走「操作被拒绝」）
    const bad = await runWriteTool(ctx.db, { kind: 'suggest_event', payload: { targetTaskId: taskId, targetField: 'status', targetValue: '完成后' } }, { member, evt })
    expect(bad.type).toBe('refused')
    expect(bad.text).toContain('操作被拒绝')

    // 无原始消息上下文（evt 缺省）：raw_snapshot 落 null 不炸
    const r = await runWriteTool(ctx.db, { kind: 'record_event', payload: { projectId: p.id, eventType: 'decision', summary: '无快照登记' } }, { member })
    expect(r.type).toBe('receipt')
    const row = ctx.db.prepare(`SELECT raw_snapshot, source_platform FROM project_events WHERE project_id = ? AND event_type = 'decision' ORDER BY id DESC`).get(p.id)
    expect(row.raw_snapshot).toBeNull()
    expect(row.source_platform).toBe('feishu') // 缺省平台

    // 终态项目任务面只读：任务全完成后结项，再提建议 → 拒绝
    for (const t of ctx.db.prepare('SELECT id FROM tasks WHERE project_id = ?').all(p.id)) updateTask(ctx.db, t.id, { status: 'done' }, 1)
    closeProject(ctx.db, p.id, { summary: '全部完成' }, 1)
    const ro = await runWriteTool(ctx.db, { kind: 'suggest_event', payload: { targetTaskId: taskId, targetField: 'status', targetValue: 'doing' } }, { member, evt })
    expect(ro.type).toBe('refused')
    expect(ro.text).toContain('只读')
  })
})
