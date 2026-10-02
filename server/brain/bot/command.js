// S20 飞书适配器（K12 统一会话管线的 IM 面）：幂等去重 → 外部群拒答 → feishu_id 身份映射 → 斜杠命令
// （统一注册表）→ 未绑定门禁 → 渠道上下文 → 统一管线（限额/LLM/有界循环）→ 卡片渲染投递 → 全审计。
// 编排逻辑（斜杠/限额/降级/循环）在 pipeline.js，与 web（chat.js）共用；本文件只保留 IM 特有面。

import crypto from 'node:crypto'
import { getSetting } from '../../engine/settings.js'
import { mapSpeaker } from '../extract.js'
import { label } from '../../engine/enums.js'
import { today } from '../../db/time.js'
import { confirmEvent, rejectEvent } from '../../engine/events.js'
import { confirmProposal, rejectProposal } from '../../engine/proposals.js'
import { upsertChannel } from '../../engine/tasks.js'
import { listMetrics } from '../../engine/metrics.js'
import { listBotHistory } from './history.js'
import { runSlash, runConversation } from './pipeline.js'

// 绑定码签发/消费随斜杠命令移入统一管线；re-export 维持既有导入方（routes 与测试）不变
export { issueBindCode, consumeBindCode } from './pipeline.js'

// —— 签名与卡片 ——

function hmac(secret, canonical) {
  return crypto.createHmac('sha256', secret).update(canonical).digest('hex').slice(0, 16)
}

export function buildSuggestCard({ eventId, summary, eventType }, secret) {
  const value = (a) => ({ a, e: String(eventId), s: hmac(secret, `${a}:${eventId}`) })
  return {
    config: { wide_screen: true },
    header: { template: 'blue', title: { tag: 'plain_text', content: `待确认：${label('eventType', eventType)}` } },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: `**${summary}**\n建议事件 #${eventId} · 由目标任务责任人 / 项目牵头人 / 管理员确认后生效` } },
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

export function buildBindCard({ projectId, projectName, chatId, chatName }, secret) {
  return {
    config: { wide_screen: true },
    header: { template: 'green', title: { tag: 'plain_text', content: '群登记确认' } },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `将本群${chatName ? `「${chatName}」` : ''}绑定为项目**「${projectName}」**（#${projectId}）的专题渠道。\n确认后从现在开始定时抽取本群聊天归档到该项目讨论面（不回灌历史）。`,
        },
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button', text: { tag: 'plain_text', content: '确认登记' }, type: 'primary',
            value: { a: 'bind', p: String(projectId), g: String(chatId), n: String(chatName || ''), s: hmac(secret, `bind:${chatId}:${projectId}`) },
          },
        ],
      },
    ],
  }
}

// —— 主入口：处理一条入站消息事件 ——

/**
 * @param {object} evt { messageId, chatId, chatType:'p2p'|'group', senderOpenId, text, ts?, external?, chatTitle? }
 * @param {object} opts { llm(测试 fake), send({chatId,text?,card?})→{messageId}, secret(HMAC 密钥) }
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
  const reply = async (replyText, patch = {}) => {
    const sent = await send({ chatId: evt.chatId, text: replyText })
    recordReplyRow(db, sent?.messageId, evt, replyText, patch.intent)
    return finish(patch)
  }

  // ② 外部群拒答：安全不变量，静默不回（S20-7）
  if (evt.chatType === 'group' && evt.external) return finish({ result: 'refused_external' })

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
  const out = await runConversation(db, env, {
    llm: opts.llm, history, reply,
    systemPrompt: buildSystemPrompt(db, { member, channel, chatType: evt.chatType, hasHistory: history.length > 0 }),
    detailExtra: historyDegraded ? { historyDegraded: true } : undefined,
  })

  // ⑦ 卡片出口：渲染为 HMAC 签名确认卡（建议/提议/群登记），回执合成文本落 bot_reply（S20-15，LLM 可指代）
  if (out?.type === 'card') {
    const w = out.writeResult
    const secret = opts.secret ?? (process.env.GB_PMO_SESSION_SECRET || '')
    const card = w.cardKind === 'bind' ? buildBindCard(w, secret) : w.cardKind === 'propose' ? buildProposalCard(w, secret) : buildSuggestCard(w, secret)
    const sent = await send({ chatId: evt.chatId, card })
    const cardDesc = w.cardKind === 'bind'
      ? `[群登记确认卡] 将本群绑定为项目「${w.projectName}」的专题渠道，待确认`
      : w.cardKind === 'propose'
        ? `[已生成提议 #${w.proposalId}] ${w.summary}，待有权人确认`
        : `[已生成待确认事件 #${w.eventId}] ${w.summary}，待确认`
    recordReplyRow(db, sent?.messageId, evt, cardDesc, `write:${w.cardKind}`)
    return finish({ memberId: member.id, intent: `write:${w.cardKind}`, result: 'card_sent', llmCalls: out.llmCalls, detail: { ...out.detail, eventId: w.eventId ?? null } })
  }
  return out
}

// —— 卡片回调（确认/驳回/群登记） ——

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
  let replyText = ''
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
        const e = Number(v.e)
        const allowed = db.prepare(
          `SELECT 1 FROM project_events ev LEFT JOIN tasks t ON t.id = ev.target_task_id LEFT JOIN projects p ON p.id = ev.project_id
           WHERE ev.id = ? AND (t.responsible_member_id = ? OR p.lead_member_id = ?)`
        ).get(e, member.id, member.id)
        if (member.role !== 'admin' && !allowed) {
          result = 'refused_permission'
          replyText = `「${member.name}」无权处理该建议（仅目标任务责任人 / 项目牵头人 / 管理员）`
        } else if (v.a === 'confirm') {
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

每轮只输出一个 JSON 动作（不带解释）：
{"action":"query","sql":"SELECT ..."}          只读查询（最多 8 次，禁写；schema 见上）
{"action":"metric","id":"<指标id>","params":{}} 口径化指标：${metricIdList()}
{"action":"brief","projectId":1}               项目 Brief：一次取全单个项目摘要（概况/任务盘子/进行中/近期进展/下一步/风险，含中文标签）——用户整体问询某项目（「XX项目怎么样/Brief」）时优先用它，取不到再 fallback query
{"action":"write","kind":"record_event","payload":{"projectId":1,"eventType":"progress|risk|decision|blocker","summary":"一句中文"}}
{"action":"write","kind":"suggest_event","payload":{"targetTaskId":1,"targetField":"status|plan_start_date|plan_end_date|responsible_member_id","targetValue":"done|YYYY-MM-DD|成员id","summary":"可选，缺省自动生成"}}
${web ? '{"action":"write","kind":"bind_channel",...}   本场景不可用（仅飞书群聊）' : '{"action":"write","kind":"bind_channel","payload":{"projectId":1,"chatName":"群名"}}   仅群聊可用，仅项目牵头人/管理员'}
{"action":"write","kind":"propose","payload":{"kind":"update_project_status","projectId":1,"status":"active|paused","planEndDate":"YYYY-MM-DD?"}}  项目状态提议（启动须有交付日期，可同请求补）
{"action":"write","kind":"propose","payload":{"kind":"close_project","projectId":1,"summary?"}}   结项提议（确认时按 S8 校验：任务须全部完成）
{"action":"write","kind":"propose","payload":{"kind":"create_project","name":"...","typeCode":"...","leadMemberId":1,"planStartDate?","planEndDate?","tasks":["标题",...]?,"autoSchedule":true?}}  立项提议（tasks 缺省按类型内嵌清单实例化；autoSchedule=true 按「计划开始（缺省今天）→交付日期」倒排每条任务计划起止，须有 planEndDate）
{"action":"write","kind":"propose","payload":{"kind":"create_project_type","code":"...","name":"...","tasks":["标题",...]}}  新建项目类型提议（任务清单内嵌于类型）
{"action":"write","kind":"trigger","payload":{"name":"trigger_extraction|generate_project_digest|generate_person_digest|push_report","params":{}}}
{"action":"reply","text":"最终答复"}            查够/完成后回答；需要向用户澄清时也用它提问

规则：
1. 先查后答：结论必须基于 query/metric/brief 取回的数据，取不到就明说，绝不编造项目事实；项目整体状况优先 brief（数据已含中文标签，剩余天数负数=超期）。
2. 项目/任务/成员一律用你查到的真实 id；相对日期按今天换算成 YYYY-MM-DD。
3. 纯进展/风险/决策/阻塞 → record_event 直接登记；任务变更（状态/日期/责任人）→ suggest_event ${web ? '生成待确认事件（用户会在页面上确认生效），不得谎称已改' : '出确认卡，不得谎称已改'}。
4. 项目级/配置级操作（项目状态/结项/立项/项目类型）→ propose 起草提议，待有权人确认后才生效，不得谎称已执行。
5. 不支持的事（财务/合同/绩效/自动重排期求解等）直接说明不支持。
6. 回复用简洁中文，短段/列表即可。${web ? '\n6. 这是多轮会话：参考对话历史理解指代（「它/这个项目」等），历史里已有的查询结果可直接引用。' : ''}${hasHistory ? '\n7. 本次附带「对话历史」：仅供理解指代（如「它/这个项目/刚才那条」，群聊历史带说话人名）；事实与最新数据一律以本轮 query/metric 取回为准，历史结论可能已过时，不得直接引用历史数字回答现状。' : ''}`
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
