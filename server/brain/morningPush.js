// 大脑·每日项目群晨报（S68，v0.75，K54）：调度器 morning 任务（默认每日 09:30）。
// 数据底座复用 S28 engine/morning.js 单项目确定性块（状态/交付倒计时/今日到期/逾期/昨日以来动态）
// + 新增「近期开工」窗口（未来 7 天计划开工的未完 work 任务，≤5 条带总数，常量护栏）。
// 正文骨架由代码拼装——【项目概况】/【逾期任务】/【近期开工】/【昨日以来动态】分节 + list 行
// （richPost 走 post）；LLM（purpose=morning）只写概况段「综述」2-4 句：转述给定数据、不编造
// （S28「LLM 只转述不拼口径」同则），未配置/失败降级确定性一句，分节结构不变。
// dedicated-only（S60 同口径）；项目级日幂等（pushes morning+project+北京日判重），重启补跑安全；
// 纯只读汇总推送，不改任何业务数据、不进确认卡。

import { today, bjDayStartMs, addDays } from '../db/time.js'
import { morningReport } from '../engine/morning.js'
import { getLlm } from './llm.js'
import { notifyProjectChannel } from './push.js'

const UPCOMING_START_DAYS = 7
const MORNING_PUSH_LIMITS = { upcomingStarts: 5 }

/** 近期开工：未来 7 天计划开工、尚未开始的未完工作任务（K40：纯提醒不进追踪口径，不混入）。 */
function upcomingStarts(db, projectId, todayStr) {
  const until = addDays(todayStr, UPCOMING_START_DAYS)
  const where = `t.project_id = ? AND t.kind = 'work' AND t.status = 'todo' AND t.deleted_at IS NULL
     AND t.plan_start_date IS NOT NULL AND t.plan_start_date > ? AND t.plan_start_date <= ?`
  const rows = db.prepare(
    `SELECT t.title, t.plan_start_date, m.name AS responsible FROM tasks t
     LEFT JOIN members m ON m.id = t.responsible_member_id
     WHERE ${where} ORDER BY t.plan_start_date LIMIT ?`
  ).all(projectId, todayStr, until, MORNING_PUSH_LIMITS.upcomingStarts)
    .map((r) => ({ title: r.title, planStartDate: r.plan_start_date, responsible: r.responsible }))
  const total = db.prepare(`SELECT COUNT(*) AS n FROM tasks t WHERE ${where}`).get(projectId, todayStr, until).n
  return { until, rows, total }
}

/** 综述降级：确定性一句（数据都来自晨报块，不编造）。 */
function fallbackOverview(block) {
  return `${block.overdueTotal ? `有 ${block.overdueTotal} 项逾期任务需要关注，` : '无逾期任务，'}未完共 ${block.openCount} 项` +
    `${block.events.length ? `，昨日以来 ${block.events.length} 条动态` : '，昨日以来无动态'}。`
}

/** LLM 只写综述段（purpose=morning 记账）；未配置/失败/空输出降级确定性一句。 */
async function writeOverview(db, projectId, block, upcoming, { llmOverride }) {
  const llm = getLlm(db, llmOverride, { purpose: 'morning', projectId })
  if (!llm) return fallbackOverview(block)
  try {
    const out = await llm.complete([
      {
        role: 'system',
        content: '你是企业项目大脑，为项目群写当日晨报的「综述」：2-4 句中文，概括项目当前态势与最值得关注的事项（逾期、交付倒计时、近期开工、昨日动态），只基于给定数据、不编造。只输出综述正文，不要标题、不要列表、不要复述全部数字。',
      },
      {
        role: 'user',
        content: `项目：${block.name}\n${block.text}\n\n近期开工（至 ${upcoming.until}）：${upcoming.rows.map((t) => `${t.title}（${t.planStartDate}）`).join('、') || '无'}`,
      },
    ])
    return String(out).trim() || fallbackOverview(block)
  } catch {
    return fallbackOverview(block) // 推送是通知语义：综述失败不阻塞晨报（与周报综述同则）
  }
}

/** 正文骨架：分节 + list 行（节头粗体；每节必在，空态给明确一行，保证结构稳定可读）。 */
function composeBody(block, upcoming, overview) {
  const lines = []
  lines.push('**【项目概况】**')
  lines.push(`- 状态：${block.statusLabel}${block.planEndDate ? ` · 交付剩 ${block.remainingDays} 天（${block.planEndDate}）` : ''}`)
  lines.push(`- 任务：进行中 ${block.doingCount} 项，未完共 ${block.openCount} 项`)
  if (block.dueToday.length) lines.push(`- 今日到期 ${block.dueToday.length}：${block.dueToday.map((t) => `${t.title}（${t.responsible || '未指派'}）`).join('、')}`)
  lines.push(`- 综述：${overview}`)
  lines.push('')
  lines.push(`**【逾期任务】${block.overdueTotal} 项**`)
  lines.push(
    block.overdueTotal
      ? block.overdueTasks.map((t) => `- ${t.title}（${t.responsible || '未指派'}，超 ${t.daysOverdue} 天，原计划 ${t.planEndDate}）`).join('\n') +
        (block.overdueTotal > block.overdueTasks.length ? `\n- （其余 ${block.overdueTotal - block.overdueTasks.length} 项略）` : '')
      : '- 无逾期任务'
  )
  lines.push('')
  lines.push(`**【近期开工】（未来 ${UPCOMING_START_DAYS} 天，共 ${upcoming.total} 项）**`)
  lines.push(
    upcoming.rows.length
      ? upcoming.rows.map((t) => `- ${t.title}（计划 ${t.planStartDate} 开工${t.responsible ? `，${t.responsible}` : '，未指派'}）`).join('\n') +
        (upcoming.total > upcoming.rows.length ? `\n- （其余 ${upcoming.total - upcoming.rows.length} 项略）` : '')
      : `- 未来 ${UPCOMING_START_DAYS} 天无新开工安排`
  )
  lines.push('')
  lines.push('**【昨日以来动态】**')
  lines.push(block.events.length ? block.events.map((e) => `- ${e.date} ${e.speaker}：${e.summary}（${e.typeLabel}）`).join('\n') : '- 昨日以来无动态')
  return lines.join('\n')
}

/** 调度入口：遍历在跑项目逐个推送（单项目失败不阻塞其余，结果逐项回显）。 */
export async function dailyProjectMorningPush(db, { llm: llmOverride, send, now = Date.now } = {}) {
  const nowMs = now()
  const todayStr = today(nowMs)
  const dayStart = bjDayStartMs(nowMs)
  const projects = db.prepare(
    `SELECT id, name FROM projects WHERE status = 'active'
     ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, id`
  ).all()
  const results = []
  for (const p of projects) {
    // dedicated 群绑定检查：无绑定 = 无目标，静默跳过（晨报是群盘面，个人视角由日报/梳理覆盖）
    const hasChannel = db.prepare(
      `SELECT 1 FROM channels WHERE project_id = ? AND platform = 'feishu' AND channel_type = 'dedicated' LIMIT 1`
    ).get(p.id)
    if (!hasChannel) {
      results.push({ projectId: p.id, skipped: true, reason: '无绑定专题群' })
      continue
    }
    // 项目级日幂等：当日已推不重发（进程重启补跑安全）
    const dup = db.prepare(
      `SELECT 1 FROM pushes WHERE push_type = 'morning' AND related_project_id = ? AND created_at >= ? LIMIT 1`
    ).get(p.id, dayStart)
    if (dup) {
      results.push({ projectId: p.id, skipped: true, reason: '今日已推送' })
      continue
    }
    try {
      const block = morningReport(db, { projectId: p.id, now: nowMs }).projects[0]
      const upcoming = upcomingStarts(db, p.id, todayStr)
      const overview = await writeOverview(db, p.id, block, upcoming, { llmOverride })
      await notifyProjectChannel(
        db, p.id,
        { pushType: 'morning', title: `项目晨报 ${todayStr} · ${p.name}`, body: composeBody(block, upcoming, overview) },
        { send }
      )
      results.push({ projectId: p.id, pushed: true })
    } catch (e) {
      results.push({ projectId: p.id, error: String(e?.message || e).slice(0, 300) })
    }
  }
  return { at: todayStr, results }
}
