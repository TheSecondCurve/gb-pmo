// 调度器（S18，v0.7）：七项定时任务（信息更新对齐 / 预警 / 日报 / 项目日历同步 / 数据库备份 / 每周梳理与周报〔S49〕/ 每日项目群晨报〔S68，v0.75〕）
// 由 settings.scheduler 的 cron + 每任务 enabled 开关驱动。调度器随进程默认运行（原 ENABLE_SCHEDULER 环境变量已删除）；
// 心跳每分钟读配置判定（改配置保存即生效，无需重启）；判定语义 =「上次运行之后到现在」窗口内存在 cron 匹配分钟（isDue）。
// 测试不启动调度器（测试只走 buildApp；心跳行为用注入 runners 直测）。

import { getSetting } from '../engine/settings.js'
import { bjDayStartMs } from '../db/time.js'
import { isDue } from '../engine/cron.js'
import { camelizeRows } from '../db/index.mjs'

// 任务表：key 顺序即执行顺序；runners 可整体注入（测试）
export const TASKS = [
  { key: 'extraction', cronKey: 'extractionCron', enabledKey: 'extractionEnabled' },
  { key: 'alerts', cronKey: 'alertCron', enabledKey: 'alertEnabled' },
  { key: 'report', cronKey: 'reportCron', enabledKey: 'reportEnabled' },
  { key: 'calendarSync', cronKey: 'calendarSyncCron', enabledKey: 'calendarSyncEnabled' },
  { key: 'backup', cronKey: 'backupCron', enabledKey: 'backupEnabled' }, // S34 数据库异地备份（存储未配全时 runner 内部跳过）
  { key: 'digest', cronKey: 'digestCron', enabledKey: 'digestEnabled' }, // S49 每周梳理 + 老板周报（runner 内周级幂等）
  { key: 'morning', cronKey: 'morningCron', enabledKey: 'morningEnabled' }, // S68 每日项目群晨报（runner 内项目级日幂等）
]

const DEFAULT_RUNNERS = {
  extraction: async (db, { llm }) => (await import('./extract.js')).runExtraction(db, {}, { llm }),
  alerts: async (db) => {
    await (await import('./alert.js')).evaluateAlerts(db)
    // S57（v0.62）：纯提醒复用预警巡检周期（日级语义，15 分钟粒度足够；时点门槛在 runner 内把守）
    await (await import('./reminder.js')).evaluateReminders(db)
  },
  report: async (db) => (await import('./report.js')).dailyReport(db, { force: false }),
  calendarSync: async (db) => (await import('./calendar.js')).syncProjectCalendar(db),
  backup: async (db) => (await import('../engine/backup.js')).runBackup(db),
  digest: async (db, { llm }) => (await import('./digest.js')).weeklyDigestRun(db, { llm }),
  morning: async (db, { llm }) => (await import('./morningPush.js')).dailyProjectMorningPush(db, { llm }),
}

/** 纯判定：给定调度配置（含 cron 与 enabled）与各任务上次运行时刻，返回此刻应跑的任务 key 数组。
 *  cronKey 缺失（部分配置/测试构造）视为未排期跳过；生产运行时 getSetting 与默认值深合并恒完整。 */
export function dueTasks(cfg, lastRuns, nowMs) {
  return TASKS
    .filter((t) => cfg[t.enabledKey] !== false && cfg[t.cronKey])
    .filter((t) => isDue(cfg[t.cronKey], lastRuns[t.key] ?? 0, nowMs))
    .map((t) => t.key)
}

/**
 * 冷启动锚点：report 锚定 max(今日 00:00, 最近一次日报推送时刻) —— 停机跨过时点当日补发、
 * 已发不重发由窗口语义 + dailyReport 当日去重兜底；digest（S49 周任务）锚定今日 00:00——跨过
 * cron 时点的重启可补跑，周级幂等由 weeklyDigestRun 周报推送行判重兜底；morning（S68）v0.77 起
 * 锚定进程启动时刻——重启/停机跨过时点不补跑（发版重启不再向项目群追发，错过当日走 S67-5 手动
 * 触发）；其余任务锚定当前时刻（游标/预警本身幂等增量）。
 */
export function initialLastRun(db, taskKey, nowMs) {
  if (taskKey === 'digest') return bjDayStartMs(nowMs)
  if (taskKey !== 'report') return nowMs
  const dayStart = bjDayStartMs(nowMs) // 「今日」按北京日（S19）
  const lastPush = db
    .prepare(`SELECT MAX(created_at) AS t FROM pushes WHERE push_type = 'daily_report' AND created_at >= ?`)
    .get(dayStart)?.t
  return Math.max(dayStart, lastPush ?? 0)
}

/** 手动触发单任务（S67-5）：与调度器同一 runner 表（可注入覆盖），未知键 400。
 *  幂等语义与定时完全一致——不在手动路径绕过 runner 内判重（晨报日判重/周报周判重等）。
 *  成败统一落 scheduler_runs 台账（S67-6，origin 默认 manual）。 */
export async function runTask(db, key, { llm, runners, origin = 'manual', memberId = null } = {}) {
  const runs = { ...DEFAULT_RUNNERS, ...runners }
  const runner = runs[key]
  if (!runner) throw Object.assign(new Error(`未知调度任务: ${key}（可用: ${TASKS.map((t) => t.key).join(' / ')}）`), { statusCode: 400 })
  const startedAt = Date.now()
  try {
    const result = await runner(db, { llm: llm ?? undefined })
    recordRun(db, key, origin, startedAt, true, result, memberId)
    return result
  } catch (e) {
    recordRun(db, key, origin, startedAt, false, e, memberId)
    throw e
  }
}

// —— S67-6（v0.77，K59）运行台账：cron 与手动触发统一落行，「定时任务→运行记录」可读 ——

/** 运行摘要：results 数组聚合计数（晨报/梳理逐项目结果），其余 JSON 截断 400 字，空结果 null。 */
function summarizeResult(result) {
  if (result && typeof result === 'object' && Array.isArray(result.results)) {
    const rs = result.results
    return JSON.stringify({
      total: rs.length,
      pushed: rs.filter((r) => r.pushed).length,
      skipped: rs.filter((r) => r.skipped).length,
      failed: rs.filter((r) => r.error).length,
    })
  }
  if (result === null || result === undefined) return null
  const s = JSON.stringify(result)
  return s.length > 400 ? `${s.slice(0, 400)}…` : s
}

/** 台账落行：成功记摘要、失败记错误消息；失败不抛（由调用方决定继续/上抛）。
 *  endedAt 由调用方传（tick 用注入时钟、runTask 用真实时钟——避免混源出负时长）。 */
function recordRun(db, task, origin, startedAt, ok, result, memberId = null, endedAt = Date.now()) {
  db.prepare(
    `INSERT INTO scheduler_runs (task, origin, started_at, duration_ms, ok, summary, member_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    task, origin, startedAt, endedAt - startedAt, ok ? 1 : 0,
    ok ? summarizeResult(result) : JSON.stringify({ error: String(result?.message ?? result).slice(0, 300) }),
    memberId, endedAt
  )
}

/** 台账查询：最近 N 条新→旧（1~200 钳制），手动触发联查操作人名。 */
export function listSchedulerRuns(db, { limit = 50 } = {}) {
  return camelizeRows(db.prepare(
    `SELECT r.id, r.task, r.origin, r.started_at, r.duration_ms, r.ok, r.summary, m.name AS member_name
     FROM scheduler_runs r LEFT JOIN members m ON m.id = r.member_id
     ORDER BY r.id DESC LIMIT ?`
  ).all(Math.min(Math.max(limit, 1), 200)))
}

export function startScheduler(db, { llm = null, logger = console, tickMs = 60_000, now = Date.now, runners } = {}) {
  const runs = { ...DEFAULT_RUNNERS, ...runners }
  const lastRuns = {}
  for (const t of TASKS) lastRuns[t.key] = initialLastRun(db, t.key, now())

  let busy = false
  const tick = async () => {
    if (busy) return // 上一拍未跑完（任务慢于心跳）则跳过本拍
    busy = true
    try {
      const cfg = getSetting(db, 'scheduler')
      for (const key of dueTasks(cfg, lastRuns, now())) {
        const startedAt = now()
        try {
          // v0.15：未注入适配器时传 undefined——runner 内 getLlm(db) 每次执行按当前配置动态解析
          //（后台切换 LLM 类别/后配 key 对定时任务即时生效，无需重启；注入的 fake/适配器仍原样透传）
          const result = await runs[key](db, { llm: llm ?? undefined })
          recordRun(db, key, 'cron', startedAt, true, result, null, now()) // S67-6 运行台账
        } catch (e) {
          logger.error(`[scheduler] ${key}:`, e.message) // 失败也推进锚点，下个周期再试
          try {
            recordRun(db, key, 'cron', startedAt, false, e, null, now()) // 失败同样落台账（不阻塞同拍其余任务）
          } catch (recErr) { // 台账自身不可写（如停机关库竞态）：只记日志，不让心跳逃逸异常
            logger.error(`[scheduler] ${key}: 运行台账落行失败:`, recErr.message)
          }
        }
        lastRuns[key] = now()
      }
    } finally {
      busy = false
    }
  }

  void tick() // 冷启动立即判定一次（日报停机补发在此生效）
  const timer = setInterval(() => void tick(), tickMs)
  return { stop: () => clearInterval(timer) }
}
