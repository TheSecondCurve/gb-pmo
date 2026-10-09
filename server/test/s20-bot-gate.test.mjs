import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupApp, loginCookie, authed } from './helpers.mjs'
import { BOT_SECRET as SECRET, scriptedLlm, makeRecorder, makeMsgFactory, mkProject, botRow } from './bot-kit.mjs'
import { handleBotEvent, handleCardAction, issueBindCode } from '../brain/bot/command.js'
import { parseSdkMessage, extractMessageText } from '../brain/bot/gateway.js'
import { sendText, sendCard } from '../brain/connectors/feishu.js'
import { setSetting } from '../engine/settings.js'

// PRD S20 — 机器人指令通道·门禁与查询面：身份门禁 / 群规则 / @ 判定 / 网关载荷解析 / 富文本拍平 / 出站发送。
// 共享工具见 bot-kit.mjs（由 1191 行单文件按子域拆分而来，每文件独立临时库，限额互不串扰）。

let ctx
const recorder = makeRecorder()
const { nextMsgId, p2p, group } = makeMsgFactory()

beforeAll(async () => {
  ctx = await setupApp()
})
afterAll(() => ctx?.db.close())

describe('S20 机器人指令通道 — 门禁与查询', () => {
  it('S20-1: 私聊自然语言多轮查询，先查后答 + 全审计', async () => {
    const p = await mkProject(ctx, '客户A系统', ctx.members.lead.id)
    const taskId = ctx.db.prepare('SELECT id FROM tasks WHERE project_id = ? ORDER BY id').get(p.id).id
    const { llm, calls } = scriptedLlm(
      JSON.stringify({ action: 'query', sql: `SELECT id, title, status FROM tasks WHERE responsible_member_id = ${ctx.members.lead.id} AND status != 'done'` }),
      JSON.stringify({ action: 'reply', text: '你名下有 1 个未完成任务：#1 需求确认（未开始）。' })
    )
    const rec = recorder()
    const evt = p2p('fs_zhang', '我的任务有哪些？')
    const out = await handleBotEvent(ctx.db, evt, { llm, send: rec.send, secret: SECRET })
    expect(out.result).toBe('replied')
    expect(rec.sent[0].text).toContain('未完成任务')
    // system prompt：身份 + schema + 私聊上下文
    const sys = calls[0][0].content
    expect(sys).toContain('张三')
    expect(sys).toContain('tasks(')
    expect(sys).toContain('私聊')
    // 审计：result/llm_calls/detail.sql；机器人回复也落行（S20-10 的另一半）
    const row = botRow(ctx, evt.messageId)
    expect(row.result).toBe('replied')
    expect(row.llm_calls).toBe(2)
    expect(JSON.parse(row.detail).sql).toHaveLength(1)
    expect(botRow(ctx, 'bot_1').kind).toBe('bot_reply')
    expect(taskId).toBeGreaterThan(0)
  })

  it('S20-4: 未绑定私聊只回引导；/bind 绑定码闭环（含过期）；LLM 未配置降级', async () => {
    // 未绑定 → 引导，不进 LLM
    const rec0 = recorder()
    const out0 = await handleBotEvent(ctx.db, p2p('fs_new', '我的任务'), { llm: scriptedLlm().llm, send: rec0.send, secret: SECRET })
    expect(out0.result).toBe('guidance')
    expect(rec0.sent[0].text).toContain('/bind')

    // web 端点生成绑定码（王五无 feishuId）
    const cookie = await loginCookie(ctx.app, 'wangwu', 'pass-123456')
    const res = await authed(ctx.app, cookie, 'POST', '/api/v1/auth/feishu-bind-code')
    expect(res.status).toBe(200)
    expect(res.body.code).toMatch(/^\d{6}$/)
    const rec1 = recorder()
    const out1 = await handleBotEvent(ctx.db, p2p('fs_new', `/bind ${res.body.code}`), { send: rec1.send, secret: SECRET })
    expect(out1.result).toBe('bound')
    expect(rec1.sent[0].text).toContain('王五')
    expect(ctx.db.prepare('SELECT feishu_id FROM members WHERE id = ?').get(ctx.members.key.id).feishu_id).toBe('fs_new')

    // 绑定码一次性：再用 → invalid
    const rec2 = recorder()
    const out2 = await handleBotEvent(ctx.db, p2p('fs_new2', `/bind ${res.body.code}`), { send: rec2.send, secret: SECRET })
    expect(out2.result).toBe('guidance')
    expect(rec2.sent[0].text).toContain('无效或已过期')

    // 过期码
    const expired = issueBindCode(ctx.db, ctx.members.dev.id, { ttlMs: -1 })
    const rec3 = recorder()
    const out3 = await handleBotEvent(ctx.db, p2p('fs_new3', `/bind ${expired.code}`), { send: rec3.send, secret: SECRET })
    expect(out3.result).toBe('guidance')

    // 绑定后正常可用 + LLM 未配置降级（只支持斜杠）
    const rec4 = recorder()
    const out4 = await handleBotEvent(ctx.db, p2p('fs_new', '我的任务'), { send: rec4.send, secret: SECRET })
    expect(out4.result).toBe('no_llm')
    expect(rec4.sent[0].text).toContain('/help')
  })
})

describe('S20 机器人指令通道 — 群聊', () => {
  it('S20-6: 群@未绑定成员静默忽略留审计（不回复不产事件）', async () => {
    const rec = recorder()
    const evt = group('fs_stranger', 'oc_g1', '@bot 我的任务')
    const out = await handleBotEvent(ctx.db, evt, { llm: scriptedLlm().llm, send: rec.send, secret: SECRET })
    expect(out.result).toBe('ignored_unbound')
    expect(rec.sent).toHaveLength(0)
    expect(botRow(ctx, evt.messageId).result).toBe('ignored_unbound')
  })

  it('S20-7: 外部群一律拒答（安全不变量）', async () => {
    const rec = recorder()
    const out = await handleBotEvent(ctx.db, group('fs_zhang', 'oc_ext', '@bot 我的项目', { external: true }), { llm: scriptedLlm().llm, send: rec.send, secret: SECRET })
    expect(out.result).toBe('refused_external')
    expect(rec.sent).toHaveLength(0)
  })

  it('S20-8: 牵头人群内登记项目 → 确认卡 → 渠道生效 cursor=登记时刻；普通成员被拒', async () => {
    const p = await mkProject(ctx, '客户E系统', ctx.members.lead.id)
    // 普通成员发起 → 权限拒绝文案
    const { llm: devLlm } = scriptedLlm(
      JSON.stringify({ action: 'write', kind: 'bind_channel', payload: { projectId: p.id, chatName: '客户E项目群' } })
    )
    const devRec = recorder()
    const devOut = await handleBotEvent(ctx.db, group('fs_li', 'oc_bind', `@bot 这是「客户E系统」的群`), { llm: devLlm, send: devRec.send, secret: SECRET })
    expect(devOut.result).toBe('refused_permission')
    expect(devRec.sent[0].text).toContain('牵头人')

    // 牵头人发起 → 确认卡 → 确认后 channels 生效
    const { llm } = scriptedLlm(
      JSON.stringify({ action: 'query', sql: `SELECT id, name FROM projects WHERE name LIKE '%客户E%'` }),
      JSON.stringify({ action: 'write', kind: 'bind_channel', payload: { projectId: p.id, chatName: '客户E项目群' } })
    )
    const rec = recorder()
    const out = await handleBotEvent(ctx.db, group('fs_zhang', 'oc_bind', '@bot 这是「客户E系统」的群'), { llm, send: rec.send, secret: SECRET })
    expect(out.result).toBe('card_sent')
    const btn = rec.sent[0].card.elements.find((e) => e.tag === 'action').actions[0]
    expect(btn.value.a).toBe('bind')

    const before = Math.floor(Date.now() / 1000)
    const ok = await handleCardAction(ctx.db, { operatorOpenId: 'fs_zhang', value: btn.value, chatId: 'oc_bind', messageId: nextMsgId() }, { send: recorder().send, secret: SECRET })
    expect(ok.result).toBe('confirmed')
    const ch = ctx.db.prepare(`SELECT * FROM channels WHERE platform = 'feishu' AND group_key = 'oc_bind'`).get()
    expect(ch.project_id).toBe(p.id)
    expect(ch.channel_type).toBe('dedicated')
    expect(Number(ch.cursor)).toBeGreaterThanOrEqual(before) // 只抽取登记之后的聊天
  })

  it('S20-9: 未登记群问答可用（无默认上下文）；关闭开关后拒答', async () => {
    const p = await mkProject(ctx, '客户F系统', ctx.members.lead.id)
    const { llm, calls } = scriptedLlm(
      JSON.stringify({ action: 'query', sql: `SELECT COUNT(*) AS n FROM tasks WHERE project_id = ${p.id} AND status != 'done'` }),
      JSON.stringify({ action: 'reply', text: '客户F系统还有若干未完成任务。' })
    )
    const rec = recorder()
    const out = await handleBotEvent(ctx.db, group('fs_li', 'oc_free', `@bot ${p.name} 现在有哪些未完成任务`), { llm, send: rec.send, secret: SECRET })
    expect(out.result).toBe('replied')
    expect(calls[0][0].content).toContain('未登记项目群')
    expect(rec.sent[0].text).toContain('客户F系统')

    setSetting(ctx.db, 'im.feishu', { answerUnregisteredGroups: false }, 1)
    const rec2 = recorder()
    const out2 = await handleBotEvent(ctx.db, group('fs_li', 'oc_free2', '@bot 随便问个问题'), { llm: scriptedLlm().llm, send: rec2.send, secret: SECRET })
    expect(out2.result).toBe('refused_unregistered')
    expect(rec2.sent).toHaveLength(0)
    setSetting(ctx.db, 'im.feishu', { answerUnregisteredGroups: true }, 1)
  })

  it('S20-11: /bind 仅私聊有效，群里引导去私聊', async () => {
    const rec = recorder()
    const out = await handleBotEvent(ctx.db, group('fs_li', 'oc_g2', '/bind 123456'), { send: rec.send, secret: SECRET })
    expect(out.result).toBe('replied')
    expect(rec.sent[0].text).toContain('私聊')
    // 群里没有发生绑定
    expect(ctx.db.prepare(`SELECT feishu_id FROM members WHERE id = ${ctx.members.dev.id}`).get().feishu_id).toBe('fs_li')
  })
})

// S20-16（v0.26.1）— 群消息必须 @ 本机器人：应用持有 im:message.group_msg 时事件推送为
// 群内全部消息，此前网关只剥 @ 前缀不校验对象，普通聊天被当成指令 → 机器人主动搭话（线上实测）。
describe('S20 群 @ 判定（refused_not_mentioned）', () => {
  it('S20-16: 未 @ 机器人（mentioned=false）的群消息一律忽略——不回复、不进 LLM、留审计', async () => {
    const rec = recorder()
    const evt = group('fs_zhang', 'oc_g_mention', '今天中午吃什么')
    const out = await handleBotEvent(ctx.db, { ...evt, mentioned: false }, { llm: scriptedLlm().llm, send: rec.send, secret: SECRET })
    expect(out.result).toBe('refused_not_mentioned')
    expect(rec.sent).toHaveLength(0)
    const row = botRow(ctx, evt.messageId)
    expect(row.result).toBe('refused_not_mentioned')
    expect(row.llm_calls).toBeNull()
    // 不产任何事件
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM project_events WHERE summary LIKE ?').get('%中午吃什么%').n).toBe(0)

    // @ 了机器人（mentioned=true）不受影响：正常走门禁链
    const rec2 = recorder()
    const evt2 = group('fs_zhang', 'oc_g_mention', '@bot 在吗', { chatTitle: 'M群' })
    const out2 = await handleBotEvent(ctx.db, { ...evt2, mentioned: true }, { llm: scriptedLlm(JSON.stringify({ action: 'reply', text: '在的' })).llm, send: rec2.send, secret: SECRET })
    expect(out2.result).toBe('replied')
    expect(rec2.sent[0].text).toBe('在的')
    // 未带 mentioned 字段（私聊/旧调用方）不判定，兼容既有契约
    const out3 = await handleBotEvent(ctx.db, p2p('fs_zhang', '私聊不受影响'), { llm: scriptedLlm(JSON.stringify({ action: 'reply', text: '好的' })).llm, send: recorder().send, secret: SECRET })
    expect(out3.result).toBe('replied')
  })

  it('S20-16: resolveMention——mentions 比对机器人 open_id；身份缺失降级要求 @_user_N 前缀；私聊恒真', async () => {
    const { resolveMention } = await import('../brain/bot/gateway.js')
    const BOT = 'ou_bot_1'
    const M = (openId) => [{ key: '@_user_1', id: { open_id: openId } }]
    expect(resolveMention({ chatType: 'p2p', mentions: [], rawText: '你好' })).toBe(true) // 私聊不判定
    expect(resolveMention({ chatType: 'group', mentions: M(BOT), rawText: '@_user_1 在吗', botOpenId: BOT })).toBe(true)
    expect(resolveMention({ chatType: 'group', mentions: M('ou_member_9'), rawText: '@_user_1 帮我问下小王', botOpenId: BOT })).toBe(false) // @ 的是别人
    expect(resolveMention({ chatType: 'group', mentions: [], rawText: '今天中午吃什么', botOpenId: BOT })).toBe(false) // 无 @
    expect(resolveMention({ chatType: 'group', mentions: [...M('ou_member_9'), { key: '@_user_2', id: { open_id: BOT } }], rawText: '@_user_1 帮我 @机器人 在吗', botOpenId: BOT })).toBe(true) // 顺带 @ 到机器人也算
    // 身份获取失败降级：带占位前缀放行（交给后续门禁），无前缀忽略
    expect(resolveMention({ chatType: 'group', mentions: M('ou_member_9'), rawText: '@_user_1 在吗', botOpenId: null })).toBe(true)
    expect(resolveMention({ chatType: 'group', mentions: [], rawText: '随便聊聊', botOpenId: null })).toBe(false)
  })
})

// 网关接线层：SDK 真实载荷形态（1.74 官方 README：EventDispatcher 直接传入解包后 {sender, message}）。
// 此前 gateway 只取 data.event.message 恒为空，所有入站消息在审计落库前被静默丢弃——线上实测暴露的盲区。
describe('S20 网关事件载荷解析', () => {
  it('SDK 解包形态 {sender, message} 正确映射（线上实测形态，修复回归锚点）', () => {
    const r = parseSdkMessage({
      sender: { sender_id: { open_id: 'ou_x' }, sender_type: 'user' },
      message: { message_id: 'om_1', chat_id: 'oc_1', chat_type: 'p2p', message_type: 'text', content: '{"text":"你好"}' },
    })
    expect(r.msg.message_id).toBe('om_1')
    expect(r.msg.message_type).toBe('text')
    expect(r.senderOpenId).toBe('ou_x')
  })

  it('event 包络形态（{event:{sender,message}}）同样兼容', () => {
    const r = parseSdkMessage({ event: { sender: { sender_id: { open_id: 'ou_y' } }, message: { message_id: 'om_2', message_type: 'text' } } })
    expect(r.msg.message_id).toBe('om_2')
    expect(r.senderOpenId).toBe('ou_y')
  })

  it('空载荷不抛错，返回空对象由调用方按非 text 过滤', () => {
    const r = parseSdkMessage({})
    expect(r.msg).toEqual({})
    expect(r.senderOpenId).toBe('')
  })
})

// S20-20（v0.37）富文本（post）消息拍平：飞书输入框把 "- " 列表行/粘贴格式自动转 post，此前网关
// 只认 text，此类消息在审计落库前被静默丢弃（线上实测：多行带列表的立项指令零回复零痕迹）。
describe('S20-20 网关富文本（post）消息拍平', () => {
  // 2026-10-08 线上真实载荷（om_x100b6340207db5b…，飞书消息历史 API 原样）：
  // "- " 前缀被拆为独立 text 元素，段间空段落，title 为空串
  const REAL_POST_CONTENT = JSON.stringify({
    title: '',
    content: [
      [{ tag: 'text', text: '新建一个项目：问问斯斯上线前准备项目', style: [] }],
      [],
      [{ tag: 'text', text: '目前列进去的工作项：', style: [] }],
      [],
      [{ tag: 'text', text: '- ', style: [] }, { tag: 'text', text: '私董专区内容 - 下午茶上传', style: [] }],
      [{ tag: 'text', text: '- ', style: [] }, { tag: 'text', text: '私董专区内容 - 更新内训播放时长', style: [] }],
    ],
  })

  it('S20-20: 线上真实 post 载荷拍平为原文（段内元素直连、段落换行连接、空段落成空行）', () => {
    expect(extractMessageText('post', REAL_POST_CONTENT)).toBe(
      '新建一个项目：问问斯斯上线前准备项目\n\n目前列进去的工作项：\n\n- 私董专区内容 - 下午茶上传\n- 私董专区内容 - 更新内训播放时长'
    )
  })

  it('S20-20: text 原样；post 的 @元素渲染 @名字（缺省 @用户）、链接取锚文本、图片 [图片] 占位、非空 title 置顶', () => {
    expect(extractMessageText('text', JSON.stringify({ text: '你好' }))).toBe('你好')
    const post = JSON.stringify({
      title: '会议纪要',
      content: [
        [{ tag: 'text', text: '转给' }, { tag: 'at', user_id: 'ou_9', user_name: '李四' }, { tag: 'text', text: ' 处理' }],
        [{ tag: 'a', text: '参考文档', href: 'https://x' }, { tag: 'img', image_key: 'k' }],
        [{ tag: 'at', user_id: 'ou_8' }],
      ],
    })
    expect(extractMessageText('post', post)).toBe('会议纪要\n转给@李四 处理\n参考文档[图片]\n@用户')
  })

  it('S20-20: 非法 content、无段落与其余消息类型（图片/文件/语音等）返回空串，由网关静默忽略', () => {
    expect(extractMessageText('post', 'not-json')).toBe('')
    expect(extractMessageText('post', JSON.stringify({ title: '', content: [] }))).toBe('')
    expect(extractMessageText('image', JSON.stringify({ image_key: 'k' }))).toBe('')
    expect(extractMessageText('text', JSON.stringify({}))).toBe('')
    // 纯空白段落拍平出 \n（非空串）——由网关既有 trim 空判定静默忽略，与旧行为一致
    expect(extractMessageText('post', JSON.stringify({ title: '', content: [[], []] }))).toBe('\n')
  })

  it('S20-20: post 私聊指令拍平后进管线——LLM 收到拍平文本、审计原文=拍平文本、照常回复', async () => {
    const { llm, calls } = scriptedLlm(
      JSON.stringify({ action: 'query', sql: 'SELECT COUNT(*) AS n FROM projects' }),
      JSON.stringify({ action: 'reply', text: '已了解，准备起草立项提议。' })
    )
    const rec = recorder()
    const evt = p2p('fs_zhang', extractMessageText('post', REAL_POST_CONTENT))
    const out = await handleBotEvent(ctx.db, evt, { llm, send: rec.send, secret: SECRET })
    expect(out.result).toBe('replied')
    expect(rec.sent[0].text).toContain('立项提议')
    // LLM 收到的用户消息 = 拍平文本（多行与 "- " 列表行保留；按列表行内容定位本条消息）
    const userMsg = calls[0].find((m) => m.role === 'user' && m.content.includes('私董专区内容 - 下午茶上传')).content
    expect(userMsg).toContain('新建一个项目：问问斯斯上线前准备项目')
    expect(userMsg).toContain('\n- 私董专区内容 - 下午茶上传')
    // 审计原文 = 拍平文本
    const row = botRow(ctx, evt.messageId)
    expect(row.raw_text).toContain('- 私董专区内容 - 更新内训播放时长')
  })
})

// 出站连接器回归锚点：receive_id_type 合法值为 chat_id（此前误传消息拉取接口的 'chat'，
// 飞书拒参导致所有机器人回复/卡片发送失败——线上实测暴露，globalThis.fetch 注桩同 S22 手法）。
describe('S20 机器人出站发送', () => {
  it('sendText/sendCard 以 receive_id_type=chat_id 调用发送接口', async () => {
    const real = globalThis.fetch
    const urls = []
    globalThis.fetch = async (url, opts = {}) => {
      const u = String(url)
      urls.push(u + ' ' + String(opts?.method || 'GET'))
      if (u.includes('/auth/v3/tenant_access_token')) return new Response(JSON.stringify({ code: 0, tenant_access_token: 't-1' }), { status: 200 })
      if (u.includes('/im/v1/messages') && opts?.method === 'POST') {
        return new Response(JSON.stringify({ code: 0, data: { message_id: 'om_out_1' } }), { status: 200 })
      }
      throw new Error('unexpected fetch: ' + u)
    }
    try {
      const cfg = { appId: 'cli_x', appSecret: 's' }
      const r1 = await sendText(cfg, 'oc_test', '你好')
      const r2 = await sendCard(cfg, 'oc_test', { config: {}, elements: [] })
      expect(r1.messageId).toBe('om_out_1')
      expect(r2.messageId).toBe('om_out_1')
      // 发送调用必须带 receive_id_type=chat_id（'chat' 会被飞书拒参）
      const sends = urls.filter((u) => u.includes('receive_id_type='))
      expect(sends.every((u) => u.includes('receive_id_type=chat_id'))).toBe(true)
      expect(sends).toHaveLength(2)
    } finally {
      globalThis.fetch = real
    }
  })
})
