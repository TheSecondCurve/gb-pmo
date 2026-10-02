// K12（v0.25）统一会话管线：门禁后的编排收敛为单管线——斜杠命令注册表（按 surface 声明可用性）、
// 每日限额（各面只计自己）、LLM 解析降级、历史注入的有界循环、出口归一化。管线只返回结构化结果不投递；
// 飞书（command.js）/web（chat.js）适配器保留各自的门禁、身份解析、投递与持久化（对外签名不变）。
// 信封差异刻意收敛为：web 恒有身份（member 必填）、channel 仅 IM 群聊——「私聊 bot ≈ web 会话」。

import crypto from 'node:crypto'
import { getSetting } from '../../engine/settings.js'
import { getLlm } from '../llm.js'
import { updateMember } from '../../engine/members.js'
import { bjDayStartMs } from '../../db/time.js'
import { morningReport } from '../../engine/morning.js'
import { runAgentLoop } from './agent.js'
import { runQueryTool, runMetricTool, runWriteTool, runBriefTool } from './tools.js'

// —— 帮助文案（按 surface；/bind 仅飞书私聊，web 清单不出现） ——

const HELP_IM = `我是项目大脑机器人，可以直接用自然语言使唤我：
· 查询/汇总：「我的任务」「A 项目现在怎么样」「逾期有哪些」「总结一下 A 项目」
· 登记：「登记进展：接口联调完成」「登记风险：等客户环境」（记录型，直接生效）
· 变更提议：「把任务 #12 标为完成」「任务 #12 推迟到 2026-10-05」（出确认卡，责任人/牵头人确认后生效）
· 群登记：管理员或牵头人在群里 @我 说「这是 XX 项目的群」
· 记忆：我记得本会话最近的对话（约 2 小时内、群聊含他人发言），发 /new 立刻清空重新开始
· 命令：/bind <绑定码>（绑定飞书账号，仅私聊）、/new（开新话题，清空上下文）、/morning（今日晨报：项目群=本项目，私聊=全部在跑项目）、/help`

const HELP_WEB = `我是项目大脑 AI 助手，直接用自然语言使唤我：
· 查询/汇总：「我的任务」「A 项目现在怎么样」「逾期有哪些」「总结一下 A 项目」
· 登记：「登记进展：接口联调完成」「登记风险：等客户环境」（记录型，直接生效）
· 变更提议：「把任务 #12 标为完成」「任务 #12 推迟到 2026-10-05」（生成待确认事件，页面上点「生效/驳回」后才变更）
· 记忆：我记得本会话最近的对话，发 /new 立刻清空重新开始（也可左侧新建会话）
· 命令：/new（别名 /clear，开新话题，清空上下文）、/morning（今日晨报：全部在跑项目）、/help`

export function helpText(surface) {
  return surface === 'web' ? HELP_WEB : HELP_IM
}

// —— 绑定码（web 生成 / 飞书私聊 /bind 消费；只存 hash，不进 LLM 与日志） ——

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex')
}

export function issueBindCode(db, memberId, { ttlMs = 10 * 60_000, now = Date.now() } = {}) {
  const code = String(100000 + crypto.randomInt(0, 900000))
  db.prepare('INSERT INTO bot_bind_codes (member_id, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .run(memberId, sha256(code), now + ttlMs, now)
  return { code, expiresAt: now + ttlMs }
}

export function consumeBindCode(db, code, openId, { now = Date.now() } = {}) {
  const row = typeof code === 'string' && /^\d{6}$/.test(code.trim())
    ? db.prepare('SELECT * FROM bot_bind_codes WHERE code_hash = ? AND used_at IS NULL AND expires_at > ? ORDER BY id DESC').get(sha256(code.trim()), now)
    : null
  if (!row) return { ok: false, reason: 'invalid' }
  try {
    const member = updateMember(db, row.member_id, { feishuId: openId }, row.member_id)
    db.prepare('UPDATE bot_bind_codes SET used_at = ? WHERE id = ?').run(now, row.id)
    return { ok: true, member }
  } catch {
    // open_id 已绑定其他成员（feishu_id UNIQUE）
    return { ok: false, reason: 'conflict' }
  }
}

// —— 斜杠命令注册表：确定性文法，进 LLM 之前（零 LLM 成本，限额/LLM 未配置不影响） ——

async function slashBind(db, env, reply) {
  if (env.chatType !== 'p2p') {
    return reply('绑定码是个人凭证，请私聊我发送 /bind <绑定码>（不要在群里晒）。', { intent: 'bind', result: 'replied' }) // S20-11
  }
  if (env.member) return reply(`你已绑定为成员「${env.member.name}」，无需重复绑定。`, { memberId: env.member.id, intent: 'bind', result: 'bound' })
  const consumed = consumeBindCode(db, env.args, env.senderOpenId)
  if (consumed.ok) {
    return reply(`绑定成功，你是「${consumed.member.name}」。现在直接对我说话就行，发 /help 看能力清单。`, { memberId: consumed.member.id, intent: 'bind', result: 'bound' })
  }
  const hint = consumed.reason === 'conflict' ? '（该飞书账号似乎已绑定其他成员，请联系管理员处理）' : ''
  return reply(`绑定码无效或已过期${hint}。请在系统 web 端登录后重新生成（10 分钟内有效），再私聊我发送 /bind <绑定码>。`, { intent: 'bind', result: 'guidance' })
}

async function slashNew(db, env, reply) {
  // S20-14（web 同构，v0.25 S24-6）：开新话题——落水位线立即清空当前会话上下文（append-only，审计行不删）
  if (!env.member) {
    return reply('还未识别你的飞书账号，暂时没有对话记忆可清空。请先在系统 web 端登录生成飞书绑定码，再私聊我发送 /bind <绑定码> 完成绑定。', { intent: 'context', result: 'guidance' })
  }
  db.prepare('INSERT INTO bot_context_resets (platform, chat_id, member_id, message_id, cleared_at) VALUES (?, ?, ?, ?, ?)')
    .run(env.platform, env.chatId || '', env.member.id, env.messageId || null, Date.now())
  return reply('已开启新话题：我不再引用此前的对话（之前的登记与提议不受影响）。', { memberId: env.member.id, intent: 'context', result: 'reset' })
}

// —— 今日晨报（S28）：定域由会话决定——专题群=本群项目，其余=全部在跑项目 ——

function morningScopeProjectId(db, env) {
  if (env.chatType !== 'group') return null
  const ch = db.prepare('SELECT channel_type, project_id FROM channels WHERE platform = ? AND group_key = ?').get(env.platform, env.chatId)
  return ch?.channel_type === 'dedicated' ? ch.project_id : null
}

async function slashMorning(db, env, reply) {
  if (!env.member) {
    return reply('还未识别你的飞书账号。请先在系统 web 端登录生成飞书绑定码（10 分钟内有效），再私聊我发送 /bind <绑定码> 完成绑定。', { intent: 'morning', result: 'guidance' })
  }
  try {
    const r = morningReport(db, { projectId: morningScopeProjectId(db, env) })
    return reply(r.text, { memberId: env.member.id, intent: 'morning', result: 'replied' })
  } catch (e) {
    return reply(`晨报生成失败：${e.message}`, { memberId: env.member.id, intent: 'morning', result: 'error' })
  }
}

const SLASH_COMMANDS = {
  '/bind': { surfaces: ['im'], run: slashBind },
  '/new': { surfaces: ['im', 'web'], aliases: ['/clear'], run: slashNew },
  '/morning': { surfaces: ['im', 'web'], aliases: ['/晨报', '/today'], run: slashMorning },
  '/help': {
    surfaces: ['im', 'web'],
    run: (db, env, reply) => reply(helpText(env.surface), { memberId: env.member?.id, intent: 'help', result: 'replied' }),
  },
}

/** 斜杠分发：确定性文法（绑定码等凭据不进 LLM）；不认识的命令回提示 + 本面能力清单。文本出口经 reply 投递。 */
export async function runSlash(db, env, reply) {
  const parts = env.text.split(/\s+/)
  const cmd = parts[0].toLowerCase()
  const entry = Object.entries(SLASH_COMMANDS).find(([name, spec]) => name === cmd || spec.aliases?.includes(cmd))
  if (entry && !entry[1].surfaces.includes(env.surface)) {
    return reply(`命令 ${cmd} 在本入口不可用。${helpText(env.surface)}`, { memberId: env.member?.id, intent: 'help', result: 'replied' })
  }
  if (!entry) {
    return reply(`不认识的命令 ${cmd}。${helpText(env.surface)}`, { memberId: env.member?.id, intent: 'help', result: 'replied' })
  }
  return entry[1].run(db, { ...env, args: parts.slice(1).join(' ') }, reply)
}

// —— 每日限额（北京日）：各面只计自己（v0.25 口径对称）——IM 面计 platform != 'web'，web 面计 platform='web' ——

export function countDailyCommands(db, memberId, surface, { now = Date.now() } = {}) {
  const scope = surface === 'web' ? "AND platform = 'web'" : "AND platform != 'web'"
  return db.prepare(
    `SELECT COUNT(*) AS n FROM bot_commands WHERE member_id = ? AND kind = 'command' AND created_at >= ? ${scope}`
  ).get(memberId, bjDayStartMs(now)).n
}

export function quotaLimit(db, surface) {
  return surface === 'web'
    ? getSetting(db, 'chat').quotaPerDay
    : getSetting(db, 'im.feishu').commandQuotaPerDay
}

const noLlmText = (surface) => surface === 'web'
  ? '系统未配置 LLM，AI 助手暂不可用。管理员可在配置台「外部依赖 → LLM」配置任一类别（DeepSeek / GLM 国内 Coding Plan）后再来。'
  : '系统未配置 LLM，自然语言指令暂不可用（管理员可在配置台填写 DeepSeek 参数）。可用命令：/help'

// —— 工具执行器（读自由写收敛；两入口共用，此前在两个编排层逐字重复） ——

export function makeExecTool(db, env, { llm, sqlLog = [] } = {}) {
  return async (parsed) => {
    if (parsed.action === 'query') {
      try {
        const r = runQueryTool(db, parsed.sql)
        sqlLog.push(String(parsed.sql).slice(0, 500))
        return `${JSON.stringify(r.rows).slice(0, 4000)}（${r.count} 行${r.truncated ? '，已截断' : ''}）`
      } catch (e) {
        return `查询失败：${e.message}（修正 SQL 重试，或基于已有信息 reply）`
      }
    }
    if (parsed.action === 'metric') {
      try {
        return JSON.stringify(runMetricTool(db, parsed.id, parsed.params)).slice(0, 4000)
      } catch (e) {
        return `指标失败：${e.message}`
      }
    }
    if (parsed.action === 'brief') {
      try {
        return JSON.stringify(runBriefTool(db, parsed.projectId)).slice(0, 6000)
      } catch (e) {
        return `Brief 失败：${e.message}（先 query 确认项目 id）`
      }
    }
    if (parsed.action === 'morning') {
      try {
        // 定域：显式 projectId 优先，其次会话上下文（专题群=本群项目，其余=全部在跑项目）
        const projectId = parsed.projectId !== undefined && parsed.projectId !== null ? Number(parsed.projectId) : morningScopeProjectId(db, env)
        return morningReport(db, { projectId }).text.slice(0, 6000)
      } catch (e) {
        return `晨报失败：${e.message}`
      }
    }
    if (parsed.action === 'write') {
      return runWriteTool(db, { kind: parsed.kind, payload: parsed.payload }, { member: env.member, evt: env.evt, llm, sourcePlatform: env.platform })
    }
    return '未知动作'
  }
}

// —— 主入口：统一会话管线 ——

/**
 * @param {object} env   会话信封 { surface:'im'|'web', platform, chatId, chatType, member, channel?,
 *                       text, ts, messageId?, senderOpenId?, evt?(原始 IM 事件，写工具取快照/引用) }
 * @param {object} opts  { llm(测试注入), history(适配器装配的多轮上下文), reply(text,patch)→Promise,
 *                       systemPrompt(字符串), detailExtra(适配器附加审计细节，如 historyDegraded) }
 * @returns 文本出口（斜杠/限额/降级/答复/写回执）经 opts.reply 投递并透传其返回值；
 *          卡片出口返回 { type:'card', writeResult, llmCalls, detail }，由适配器渲染（飞书发卡、web 页面按钮）。
 */
export async function runConversation(db, env, opts = {}) {
  // ① 斜杠命令：确定性文法，零 LLM 成本（限额与 LLM 未配置不影响）
  if (env.text.startsWith('/')) return await runSlash(db, env, opts.reply)

  // ② 每日限额（北京日，各面只计自己）
  const limit = quotaLimit(db, env.surface)
  const used = countDailyCommands(db, env.member.id, env.surface)
  if (used > limit) {
    return await opts.reply(`今天的指令额度（${limit} 条）已用完，明天再来找我吧。`, { memberId: env.member.id, intent: 'gate', result: 'refused_quota' })
  }

  // ③ LLM 解析（未配置降级指引，斜杠命令已在上一步先行可用）
  const llm = getLlm(db, opts.llm)
  if (!llm) return await opts.reply(noLlmText(env.surface), { memberId: env.member.id, intent: 'gate', result: 'no_llm' })

  // ④ 有界循环（读自由写收敛；写即终止）
  const sqlLog = []
  const out = await runAgentLoop({
    llm,
    systemPrompt: opts.systemPrompt,
    userText: env.text,
    history: opts.history ?? [],
    execTool: makeExecTool(db, env, { llm, sqlLog }),
  })
  const detail = { turns: out.turns, queries: out.queries, sql: sqlLog, history: (opts.history ?? []).length, ...(opts.detailExtra ?? {}) }

  if (out.kind === 'reply') {
    return await opts.reply(out.text || '（空回复）', { memberId: env.member.id, intent: 'reply', result: out.result, llmCalls: out.turns, detail })
  }
  const w = out.writeResult
  if (w?.type === 'card') return { type: 'card', writeResult: w, llmCalls: out.turns, detail }
  return await opts.reply(w?.text || '操作完成。', {
    memberId: env.member.id, intent: `write:${w?.type ?? '?'}`, result: w?.result || 'replied', llmCalls: out.turns, detail, writeKind: w?.type,
  })
}
