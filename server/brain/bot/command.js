// S20 飞书适配器（K12 统一会话管线的 IM 面）：幂等去重 → 外部群拒答 → feishu_id 身份映射 → 斜杠命令
// （统一注册表）→ 未绑定门禁 → 渠道上下文 → 统一管线（限额/LLM/有界循环）→ 卡片渲染投递 → 全审计。
// 编排逻辑（斜杠/限额/降级/循环）在 pipeline.js，与 web（chat.js）共用；本文件只保留 IM 特有面。

import crypto from 'node:crypto'
import { getSetting } from '../../engine/settings.js'
import { mapSpeaker, bufferInboundMessage } from '../extract.js'
import { label } from '../../engine/enums.js'
import { today } from '../../db/time.js'
import { confirmEvent, rejectEvent } from '../../engine/events.js'
import { confirmProposal, rejectProposal } from '../../engine/proposals.js'
import { upsertChannel } from '../../engine/tasks.js'
import { listMetrics } from '../../engine/metrics.js'
import { listBotHistory } from './history.js'
import { runSlash, runConversation } from './pipeline.js'
import { richPost } from './format.js'
import { buildMorningCard, buildTasksInventoryCard } from './cards.js'

// 绑定码签发/消费随斜杠命令移入统一管线；re-export 维持既有导入方（routes 与测试）不变
export { issueBindCode, consumeBindCode } from './pipeline.js'

// S20-19（v0.36）私聊占位反馈：确定走 LLM 循环后先发占位文本，答案就绪把同一条消息原地编辑为最终答复
// （编辑接口见 connectors/feishu.js#patchText）。飞书无原生「正在输入」状态，此为等价形态。
const TYPING_TEXT = '收到，正在处理…'

// —— 签名与卡片（v0.46/K25：确认卡仅余取消/结项提议；存量建议卡/群登记卡的点按由 handleCardAction 兼容分支承接） ——

function hmac(secret, canonical) {
  return crypto.createHmac('sha256', secret).update(canonical).digest('hex').slice(0, 16)
}

export function buildProposalCard({ proposalId, summary }, secret) {
  const value = (c) => ({ a: 'prop', p: String(proposalId), c, s: hmac(secret, `prop:${c}:${proposalId}`) })
  return {
    config: { wide_screen: true },
    header: { template: 'orange', title: { tag: 'plain_text', content: `操作提议 #${proposalId}` } },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: `**${summary}**\n由有权人确认后生效（项目操作：牵头人/管理员；立项：管理员/拟任牵头人；项目类型：管理员）` } },
      {
        tag: 'action',
        actions: [
          { tag: 'button', text: { tag: 'plain_text', content: '确认生效' }, type: 'primary', value: value('confirm') },
          { tag: 'button', text: { tag: 'plain_text', content: '驳回' }, type: 'danger', value: value('reject') },
        ],
      },
    ],
  }
}

// —— 主入口：处理一条入站消息事件 ——

/**
 * @param {object} evt { messageId, chatId, chatType:'p2p'|'group', senderOpenId, text, ts?, external?, chatTitle? }
 * @param {object} opts { llm(测试 fake), send({chatId,text?,card?})→{messageId}, secret(HMAC 密钥),
 *                       patch?({chatId,messageId,text})→{ok}(S20-19 占位消息编辑通道，注入后私聊慢路径启用占位反馈) }
 */
export async function handleBotEvent(db, evt, opts = {}) {
  const startedAt = Date.now()
  const send = opts.send || (async () => ({ messageId: null }))
  const platform = evt.platform || 'feishu'
  const text = String(evt.text || '').trim()

  // ① 去重：message_id 唯一键（飞书重复投递幂等）
  const ins = db
    .prepare(
      `INSERT OR IGNORE INTO bot_commands (message_id, platform, chat_id, chat_type, sender_open_id, kind, raw_text, created_at)
       VALUES (?, ?, ?, ?, ?, 'command', ?, ?)`
    )
    .run(evt.messageId, platform, evt.chatId || null, evt.chatType || null, evt.senderOpenId || null, text.slice(0, 2000), startedAt)
  if (ins.changes === 0) return { result: 'ignored_dedup' }
  const rowId = Number(ins.lastInsertRowid)

  const finish = (patch = {}) => {
    db.prepare('UPDATE bot_commands SET member_id = ?, intent = ?, detail = ?, result = ?, llm_calls = ?, duration_ms = ? WHERE id = ?')
      .run(patch.memberId ?? null, patch.intent ?? null, patch.detail ? JSON.stringify(patch.detail) : null,
        patch.result ?? null, patch.llmCalls ?? null, Date.now() - startedAt, rowId)
    return { result: patch.result }
  }
  // S20-19 占位消息 id：慢路径开始（onLlmStart）时落值；答案经 reply/卡片出口消费后清空。
  // 占位消息 id 即最终答复 bot_reply 回执行的 id（编辑不换 id，审计与多轮上下文口径不变）。
  let typingMessageId = null
  // S45（v0.50，K28）输出分流：①patch.structured（引擎结构化结果：morning/tasks）→ 卡片出口，
  // 审计落引擎完整纯文本，卡片发送失败降级为纯文本补发；②其余答复 richPost 判定——多行/粗体/链接
  // 走 post 富文本，单行短回执维持 text；占位消息按最终载荷同型编辑；post 发送失败同样降级 text。
  const reply = async (replyText, patch = {}) => {
    const { structured, ...rest } = patch
    if (structured) {
      const card = structured.kind === 'morning' ? buildMorningCard(structured.data) : buildTasksInventoryCard(structured.data)
      if (typingMessageId) {
        const mid = typingMessageId
        typingMessageId = null
        try { await opts.patch?.({ chatId: evt.chatId, messageId: mid, text: String(replyText).split('\n')[0] }) } catch { /* 占位留原地 */ }
      }
      let sent
      try {
        sent = await send({ chatId: evt.chatId, card })
      } catch {
        sent = await send({ chatId: evt.chatId, text: replyText }) // 必达兜底：卡片失败纯文本补发同内容
      }
      recordReplyRow(db, sent?.messageId, evt, replyText, rest.intent)
      return finish(rest)
    }
    const post = richPost(replyText)
    if (typingMessageId) {
      const mid = typingMessageId
      typingMessageId = null
      let edited
      try {
        edited = Boolean(await opts.patch?.({ chatId: evt.chatId, messageId: mid, text: post ? undefined : replyText, post: post ?? undefined }))
      } catch { edited = false }
      if (edited) {
        recordReplyRow(db, mid, evt, replyText, patch.intent)
        return finish(patch)
      }
      // 编辑失败降级：占位留在原地，答案改发新消息（必达，不阻塞）
    }
    let sent
    try {
      sent = await send({ chatId: evt.chatId, text: post ? undefined : replyText, post: post ?? undefined })
    } catch (e) {
      if (!post) throw e // 纯文本发送失败无更降级路径，原样上抛
      sent = await send({ chatId: evt.chatId, text: replyText })
    }
    recordReplyRow(db, sent?.messageId, evt, replyText, patch.intent)
    return finish(patch)
  }

  // ② 外部群拒答：安全不变量，静默不回（S20-7）
  if (evt.chatType === 'group' && evt.external) return finish({ result: 'refused_external' })

  // ②b 群消息必须 @ 本机器人（S20-16/v0.26.1）：group_msg 权限下事件推送为群内全部消息，
  // 未 @ 一律忽略（不回复/不产事件/不进 LLM）；mentioned 缺省不判定（私聊与旧调用方兼容）
  // S52（v0.57，K35）：拒答的同时把已绑定渠道的消息落 im_buffer 抽取缓冲（拒答语义不变）
  if (evt.chatType === 'group' && evt.mentioned === false) {
    bufferInboundMessage(db, { platform, groupKey: evt.chatId, messageId: evt.messageId, speakerId: evt.senderOpenId, text, ts: evt.ts })
    return finish({ result: 'refused_not_mentioned' })
  }

  // ③ 身份门禁：只认 members.feishu_id 映射到的在职成员（权限跟人不跟群）
  const member = mapSpeaker(db, platform, evt.senderOpenId)
  // 命中即回填审计行 member_id（限额统计需要把当前这条计入）
  if (member) db.prepare('UPDATE bot_commands SET member_id = ? WHERE id = ?').run(member.id, rowId)

  const env = {
    surface: 'im', platform, chatId: evt.chatId, chatType: evt.chatType, member,
    text, ts: evt.ts ?? Date.now(), messageId: evt.messageId, senderOpenId: evt.senderOpenId, evt,
  }

  // ④ 斜杠命令：统一注册表（确定性文法，绑定码不进 LLM）——先于未登记群开关，未登记群也能 /help（既有语义）
  if (text.startsWith('/')) return await runSlash(db, env, reply)

  if (!member) {
    if (evt.chatType === 'p2p') {
      return reply('还未识别你的飞书账号。请先在系统 web 端登录生成飞书绑定码（10 分钟内有效），再私聊我发送 /bind <绑定码> 完成绑定。', { intent: 'gate', result: 'guidance' })
    }
    return finish({ result: 'ignored_unbound' }) // 群里静默忽略（S20-6，含离职成员）
  }

  // ⑤ 渠道上下文：已登记群带默认项目；未登记群按开关决定是否响应（S20-9）
  let channel = null
  if (evt.chatType === 'group') {
    channel = db.prepare('SELECT * FROM channels WHERE platform = ? AND group_key = ?').get(platform, evt.chatId) || null
    if (!channel && !getSetting(db, 'im.feishu').answerUnregisteredGroups) return finish({ memberId: member.id, intent: 'gate', result: 'refused_unregistered' })
  }

  // ⑥ 统一管线：限额/LLM 解析/有界循环（K12）；S20-13 同会话多轮上下文（装配失败降级为无历史，不阻塞主链路）
  const cfg = getSetting(db, 'im.feishu')
  let history = []
  let historyDegraded = false
  try {
    history = listBotHistory(db, { platform, chatId: evt.chatId, chatType: evt.chatType }, {
      turns: cfg.contextTurns, idleMs: Math.max(0, cfg.contextIdleMinutes) * 60_000,
    })
  } catch {
    historyDegraded = true
  }
  // S20-19：仅私聊 + 开关开 + 调用方注入了编辑能力才占位（群聊一期不做；旧调用方/未注入 patch 行为与今天一致）
  const typingEnabled = evt.chatType === 'p2p' && cfg.typingFeedback !== false && typeof opts.patch === 'function'
  const onLlmStart = typingEnabled ? async () => {
    const sent = await send({ chatId: evt.chatId, text: TYPING_TEXT })
    if (sent?.messageId) typingMessageId = sent.messageId
  } : undefined
  let out
  try {
    out = await runConversation(db, env, {
      llm: opts.llm, history, reply, fetchChat: opts.fetchChat, onLlmStart,
      systemPrompt: buildSystemPrompt(db, { member, channel, chatType: evt.chatType, hasHistory: history.length > 0 }),
      detailExtra: historyDegraded ? { historyDegraded: true } : undefined,
    })
  } catch (e) {
    // S20-19：循环抛错时占位尽力改为失败提示（不留「正在处理」孤儿），再原样上抛（网关日志语义不变）
    if (typingMessageId) {
      const mid = typingMessageId
      typingMessageId = null
      try { await opts.patch({ chatId: evt.chatId, messageId: mid, text: `处理失败：${e.message}` }) } catch { /* 尽力而为 */ }
    }
    throw e
  }

  // ⑦ 卡片出口：渲染为 HMAC 签名确认卡（v0.46/K25 起仅取消/结项提议卡），回执合成文本落 bot_reply（S20-15，LLM 可指代）
  if (out?.type === 'card') {
    const w = out.writeResult
    const secret = opts.secret ?? (process.env.GB_PMO_SESSION_SECRET || '')
    const card = buildProposalCard(w, secret)
    const cardDesc = `[已生成提议 #${w.proposalId}] ${w.summary}，待有权人确认`
    // S20-19：占位消息编辑为合成回执文本（尽力而为，失败不阻塞卡片发送）
    if (typingMessageId) {
      const mid = typingMessageId
      typingMessageId = null
      try { await opts.patch({ chatId: evt.chatId, messageId: mid, text: cardDesc }) } catch { /* 占位留原地 */ }
    }
    const sent = await send({ chatId: evt.chatId, card })
    recordReplyRow(db, sent?.messageId, evt, cardDesc, `write:${w.cardKind}`)
    return finish({ memberId: member.id, intent: `write:${w.cardKind}`, result: 'card_sent', llmCalls: out.llmCalls, detail: { ...out.detail, proposalId: w.proposalId ?? null } })
  }
  return out
}

// —— 卡片回调（确认/驳回/群登记） ——
// v0.46/K25：对话面不再产建议卡与群登记卡（直改/直写），confirm/reject 与 bind 分支保留以兼容存量卡片点按；
// prop 分支是在役路径（取消/结项提议卡）。

/**
 * @param {object} cardEvt { operatorOpenId, value:{a,e?,s?}|{a:'bind',p,g,n,s}, chatId, messageId? }
 * @param {object} opts { send, secret }
 */
export async function handleCardAction(db, cardEvt, opts = {}) {
  const startedAt = Date.now()
  const send = opts.send || (async () => ({}))
  const secret = opts.secret ?? (process.env.GB_PMO_SESSION_SECRET || '')
  const v = cardEvt?.value && typeof cardEvt.value === 'object' ? cardEvt.value : {}
  const mid = cardEvt?.messageId || `card:${startedAt}:${Math.random().toString(36).slice(2, 8)}`
  db.prepare(
    `INSERT OR IGNORE INTO bot_commands (message_id, platform, chat_id, chat_type, sender_open_id, kind, created_at)
     VALUES (?, 'feishu', ?, NULL, ?, 'card', ?)`
  ).run(mid, cardEvt?.chatId || null, cardEvt?.operatorOpenId || null, startedAt)

  const member = mapSpeaker(db, 'feishu', cardEvt?.operatorOpenId)
  let result = 'error'
  let replyText
  try {
    if (!secret) {
      replyText = '系统未配置签名密钥，无法处理卡片回调'
    } else if (v.a === 'confirm' || v.a === 'reject') {
      if (hmac(secret, `${v.a}:${v.e}`) !== v.s) {
        replyText = '卡片签名校验失败，请重新发起指令'
      } else if (!member) {
        result = 'refused_permission'
        replyText = '未识别操作者的飞书账号，无法确认'
      } else {
        // v0.34（S20-2 修订）：任务面建议全员可确认——任意已绑定成员点按生效（与 web 端点「登录即可确认」口径一致），
        // 身份门禁（绑定成员）保留；decided_by=点按人留痕不变
        const e = Number(v.e)
        if (v.a === 'confirm') {
          const confirmed = confirmEvent(db, e, member.id)
          result = 'confirmed'
          replyText = `已生效：事件 #${e}（${confirmed.summary}），由 ${member.name} 确认。`
        } else {
          rejectEvent(db, e, member.id)
          result = 'rejected'
          replyText = `已驳回：事件 #${e}，由 ${member.name} 操作。`
        }
      }
    } else if (v.a === 'bind') {
      if (hmac(secret, `bind:${v.g}:${v.p}`) !== v.s) {
        replyText = '卡片签名校验失败，请重新发起指令'
      } else if (!member) {
        result = 'refused_permission'
        replyText = '未识别操作者的飞书账号'
      } else {
        const project = db.prepare('SELECT id, name, lead_member_id FROM projects WHERE id = ?').get(Number(v.p))
        if (!project) {
          replyText = '项目已不存在，登记取消'
        } else if (member.role !== 'admin' && project.lead_member_id !== member.id) {
          result = 'refused_permission'
          replyText = `「${member.name}」无权登记（仅项目牵头人或管理员）`
        } else {
          // 新建绑定 cursor=登记时刻（upsertChannel 落值，S3-6/v0.24 统一）：只抽取登记之后的聊天，不回灌历史；
          // 该群此前已绑定过时为更新，保留游标不重置
          upsertChannel(db, { platform: 'feishu', groupKey: v.g, name: v.n || null, channelType: 'dedicated', projectId: project.id }, member.id)
          result = 'confirmed'
          replyText = `本群已绑定为项目「${project.name}」的专题渠道，从现在开始定时抽取归档。`
        }
      }
    } else if (v.a === 'prop') {
      if (hmac(secret, `prop:${v.c}:${v.p}`) !== v.s) {
        replyText = '卡片签名校验失败，请重新发起指令'
      } else if (!member) {
        result = 'refused_permission'
        replyText = '未识别操作者的飞书账号，无法确认'
      } else {
        try {
          if (v.c === 'confirm') {
            await confirmProposal(db, Number(v.p), member.id)
            result = 'confirmed'
            replyText = `提议 #${v.p} 已生效。`
          } else {
            await rejectProposal(db, Number(v.p), member.id)
            result = 'rejected'
            replyText = `提议 #${v.p} 已驳回。`
          }
        } catch (e) {
          result = e.statusCode === 403 ? 'refused_permission' : 'error'
          replyText = e.statusCode === 403 || e.statusCode === 409 ? e.message : `处理失败：${e.message}`
        }
      }
    } else {
      replyText = '未知卡片动作'
    }
  } catch (e) {
    result = 'error'
    replyText = `处理失败：${e.message}`
  }
  if (replyText) {
    const sent = await send({ chatId: cardEvt?.chatId, text: replyText })
    // 点按结果落 bot_reply 回执（S20-15）：后续「它生效了吗」的指代依据
    recordReplyRow(db, sent?.messageId, { platform: 'feishu', chatId: cardEvt?.chatId }, replyText, `card:${v.a || '?'}`)
  }
  db.prepare('UPDATE bot_commands SET member_id = ?, intent = ?, result = ?, duration_ms = ? WHERE message_id = ?')
    .run(member?.id ?? null, `card:${v.a || '?'}`, result, Date.now() - startedAt, mid)
  return { result, text: replyText }
}

// —— 系统提示 ——

const HIDDEN_TABLES = new Set(['sessions', 'migrations_meta', 'sqlite_sequence'])
const HIDDEN_COLS = /password_hash|token_hash/

/** schema 摘要：库内省实时生成（新表新字段零成本可用，无 drift）。 */
export function schemaDigest(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all().map((r) => r.name).filter((t) => !HIDDEN_TABLES.has(t))
  return tables
    .map((t) => `${t}(${db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name).filter((c) => !HIDDEN_COLS.test(c)).join(', ')})`)
    .join('\n')
}

export function buildSystemPrompt(db, { member, channel, chatType, surface = 'im', hasHistory = false }) {
  const now = new Date()
  const weekday = '日一二三四五六'[new Date(now.getTime() + 8 * 3_600_000).getUTCDay()]
  const web = surface === 'web' // S24：web AI 助手会话（同一核心 Agent 的 web 入口）
  let ctxLine = '当前对话：用户私聊（无默认项目，涉及具体项目先确认项目名/id）。'
  if (web) {
    ctxLine = '当前对话：项目大脑 web 端 AI 助手（无默认项目，涉及具体项目先确认项目名/id；群登记类操作不可用）。'
  } else if (chatType === 'group') {
    const p = channel?.project_id ? db.prepare('SELECT id, name FROM projects WHERE id = ?').get(channel.project_id) : null
    ctxLine = channel?.channel_type === 'dedicated' && p
      ? `当前对话：项目专题群，默认项目「${p.name}」（id=${p.id}）——不点名项目的登记/变更/查询默认落到它。`
      : channel
        ? '当前对话：通用群（已登记为通用渠道），无默认项目，涉及具体项目先确认。'
        : '当前对话：未登记项目群（无默认项目，涉及具体项目先确认项目名/id）。'
  }
  return `你是「企业项目大脑」的${web ? 'AI 助手（web 会话）' : '机器人助手（以应用自身身份应答，不冒充任何成员）'}。
${ctxLine}
当前用户：${member.name}（${label('memberRole', member.role)}，id=${member.id}）。今天是 ${today(now)}（星期${weekday}），日期一律北京时区。

数据库 schema（SQLite；SQL 里的「今天」用 BJ_TODAY()）：
${schemaDigest(db)}

每轮只输出一个 JSON 动作（不带解释、不输出裸文本；要向用户说的话——答复/提问/澄清——一律装进 {"action":"reply","text":"..."}）：
{"action":"query","sql":"SELECT ..."}          只读查询（最多 8 次，禁写；schema 见上）
{"action":"metric","id":"<指标id>","params":{}} 口径化指标：${metricIdList()}
{"action":"brief","projectId":1}               项目 Brief：一次取全单个项目摘要（概况/任务盘子/进行中/近期进展/下一步/风险，含中文标签）——用户整体问询某项目（「XX项目怎么样/Brief」）时优先用它，取不到再 fallback query
{"action":"morning","projectId":1?}            今日晨报：按会话自动定域（项目专题群=本群项目；私聊/其他=全部在跑项目；可显式给 projectId 取单项目）——用户要「晨报/早报/今天的情况汇总」时优先用它
{"action":"recent_chat","limit":20}            本群最近讨论（仅项目专题群；用户提到「刚才/上面/刚才讨论的」而对话历史不足以理解时，先读它再作答/起建议）——其余会话该动作返回不可用说明
{"action":"minutes","hours":2}               群讨论纪要拉取（仅项目专题群；默认 2h、上限 6h；S54：用户要「纪要/总结讨论/记一下」时先拉取，再浓缩为三段式纪要【结论/待办/风险，标注发言人】，末尾附「回复『归档』沉淀为项目记录」；讨论为空明说，不编造；用户随后说「归档/记下来」时用 record_event 落 decision 记录）
{"action":"write","kind":"record_event","payload":{"projectId":1,"eventType":"progress|risk|decision|blocker","summary":"一句中文"}}
{"action":"write","kind":"suggest_event","payload":{"targetTaskId":1,"targetField":"status|plan_start_date|plan_end_date|responsible_member_id","targetValue":"done|YYYY-MM-DD|成员id","summary":"可选，缺省自动生成"}}  任务变更：直接生效并回执（落建议型事件留痕，发令人即生效人）
{"action":"write","kind":"suggest_event","payload":{"items":[{"targetTaskId":1,"targetField":"status","targetValue":"done"},{"targetTaskId":2,"targetField":"plan_end_date","targetValue":"2026-12-31"}]}}  一条指令含多个变更时用 items 批量（≤20 条，逐条生效、汇总回执单列失败原因）
{"action":"write","kind":"suggest_event","payload":{"targetMilestoneId":1,"targetField":"plan_date|status","targetValue":"YYYY-MM-DD|met|missed|cancelled","summary":"可选"}}  里程碑改期/状态：直接生效（met=达成）
${web ? '{"action":"write","kind":"bind_channel",...}   本场景不可用（仅飞书群聊）' : '{"action":"write","kind":"bind_channel","payload":{"projectId":1,"chatName":"群名"}}   仅群聊可用，仅项目牵头人/管理员：直接登记本群为项目专题渠道并回执（不再出确认卡）'}
{"action":"write","kind":"propose","payload":{"kind":"add_task","projectId":1,"title":"任务标题","taskKind":"work|reminder"?,"responsibleMemberId":1?,"planStartDate"?,"planEndDate"?}}  建任务：牵头人/管理员直接生效（缺省责任人=未指派（S38）；taskKind=reminder=纯提醒——到期推责任人+项目群后自动完成、不追踪状态，须给 planEndDate=提醒日）
{"action":"write","kind":"propose","payload":{"kind":"add_milestone","projectId":1,"name":"里程碑名","planDate"?}}  建里程碑：牵头人/管理员直接生效
{"action":"write","kind":"propose","payload":{"kind":"update_project","projectId":1,"name"?,"clientName"?,"priority":"high|medium|low"?,"planStartDate"?,"planEndDate"?,"leadMemberId":1?}}  项目信息变更：牵头人/管理员直接生效（至少一个字段；状态不可经此改，S29）
{"action":"write","kind":"propose","payload":{"kind":"create_project","name":"...","typeCode":"...","leadMemberId":1,"planStartDate?","planEndDate?","tasks":["标题"|{"title":"...","refs":[{"title":"SOP名","url":"https://...","note?":"备注"}]}...]?,"autoSchedule":true?}}  立项：直接生效（发起人须为管理员或拟任牵头人本人；tasks 缺省按类型内嵌清单实例化、含类型预设的逐步骤参考资料；纯标题覆盖=不带参考资料，refs 显式给出才带；autoSchedule=true 按「计划开始（缺省今天）→交付日期」倒排每条任务计划起止，须有 planEndDate）
{"action":"write","kind":"propose","payload":{"kind":"create_project_type","code":"...","name":"...","tasks":["标题"|{"title":"...","refs":[{"title":"SOP名","url":"https://..."}...]}...]}}  新建项目类型：仅管理员直接生效（任务清单内嵌于类型；有标准 SOP/知识库文档的步骤可挂 refs，每步 ≤10 条，立项时随任务预填给执行人，S33）
{"action":"write","kind":"propose","payload":{"kind":"cancel_project","projectId":1,"reason":"取消原因（必填）"}}  取消项目【终态·出确认卡】：原因必填（S29），牵头人/管理员点按确认后才生效
{"action":"write","kind":"propose","payload":{"kind":"close_project","projectId":1,"summary":"结项总结（必填）"}}   结项【终态·出确认卡】：总结必填（S29；确认时按 S8 校验：任务须全部完成）
{"action":"write","kind":"trigger","payload":{"name":"trigger_extraction|generate_project_digest|generate_person_digest|push_report","params":{}}}
{"action":"reply","text":"最终答复"}            查够/完成后回答；需要向用户澄清时也用它提问

规则：
1. 先查后答：结论必须基于 query/metric/brief 取回的数据，取不到就明说，绝不编造项目事实；项目整体状况优先 brief（数据已含中文标签，剩余天数负数=超期）。
2. 项目/任务/成员一律用你查到的真实 id；相对日期按今天换算成 YYYY-MM-DD。
3. 纯进展/风险/决策/阻塞 → record_event 直接登记；任务/里程碑变更（状态/日期/责任人）→ suggest_event **直接生效**（多个变更用 items 批量一次办完）——回执即变更结果，不得谎称已改；变更失败（任务不存在/终态项目/非法值等）会返回失败原因，如实转告。
4. 建任务/建里程碑/项目信息变更/立项/项目类型/群登记 → 直接生效并回执（发起人无权限会被拒，如实说明）；**仅取消项目/结项**走 propose 确认卡，待有权人点按后才生效，不得谎称已生效；项目没有「暂停/启动」操作（S29：状态仅 进行中→已结项/已取消）。
5. 不支持的事（财务/合同/绩效/自动重排期求解等）直接说明不支持。
6. 回复用简洁中文，短段/列表即可。群聊里用户以「刚才/上面讨论的」为据而对话历史不足以理解时，先 recent_chat 读群内最近讨论再行动（仅项目专题群可用）。${web ? '\n6. 这是多轮会话：参考对话历史理解指代（「它/这个项目」等），历史里已有的查询结果可直接引用。' : ''}${hasHistory ? '\n7. 本次附带「对话历史」：仅供理解指代（如「它/这个项目/刚才那条」，群聊历史带说话人名）；事实与最新数据一律以本轮 query/metric 取回为准，历史结论可能已过时，不得直接引用历史数字回答现状。' : ''}`
}

function metricIdList() {
  return listMetrics().map((m) => `${m.id}=${m.name}`).join('、')
}

/** 机器人回复落 bot_commands（kind=bot_reply）：定时抽取据此跳过自己的消息（S20-10），
 *  回执文本与意图一并留痕——多轮上下文的 assistant 侧来源与完整审计（S20-13/15）。 */
function recordReplyRow(db, messageId, evt, text, intent) {
  if (!messageId) return
  db.prepare(
    `INSERT OR IGNORE INTO bot_commands (message_id, platform, chat_id, chat_type, kind, raw_text, intent, created_at)
     VALUES (?, ?, ?, ?, 'bot_reply', ?, ?, ?)`
  ).run(messageId, evt.platform || 'feishu', evt.chatId || null, evt.chatType || null,
    text ? String(text).slice(0, 2000) : null, intent ?? null, Date.now())
}
