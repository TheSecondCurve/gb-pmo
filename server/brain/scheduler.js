// 调度器（S18，v0.7）：三项大脑定时任务由 settings.scheduler 的 cron + 每任务 enabled 开关驱动。
// 调度器随进程默认运行（原 ENABLE_SCHEDULER 环境变量已删除）；心跳每分钟读配置判定（改配置保存即生效，
// 无需重启）；判定语义 =「上次运行之后到现在」窗口内存在 cron 匹配分钟（isDue）。测试不启动调度器
//（测试只走 buildApp；心跳行为用注入 runners 直测）。

import { getSetting } from '../engine/settings.js'
import { bjDayStartMs } from '../db/time.js'
import { isDue } from '../engine/cron.js'

// 任务表：key 顺序即执行顺序；runners 可整体注入（测试）
export const TASKS = [
  { key: 'extraction', cronKey: 'extractionCron', enabledKey: 'extractionEnabled' },
  { key: 'alerts', cronKey: 'alertCron', enabledKey: 'alertEnabled' },
  { key: 'report', cronKey: 'reportCron', enabledKey: 'reportEnabled' },
  { key: 'calendarSync', cronKey: 'calendarSyncCron', enabledKey: 'calendarSyncEnabled' }, // S22 项目日历对账
]

const DEFAULT_RUNNERS = {
  extraction: async (db, { llm }) => (await import('./extract.js')).runExtraction(db, {}, { llm }),
  alerts: async (db) => (await import('./alert.js')).evaluateAlerts(db),
  report: async (db) => (await import('./report.js')).dailyReport(db, { force: false }),
  calendarSync: async (db) => (await import('./calendar.js')).syncProjectCalendar(db),
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
 * 已发不重发由窗口语义 + dailyReport 当日去重兜底；其余任务锚定当前时刻（游标/预警本身幂等增量）。
 */
export function initialLastRun(db, taskKey, nowMs) {
  if (taskKey !== 'report') return nowMs
  const dayStart = bjDayStartMs(nowMs) // 「今日」按北京日（S19）
  const lastPush = db
    .prepare(`SELECT MAX(created_at) AS t FROM pushes WHERE push_type = 'daily_report' AND created_at >= ?`)
    .get(dayStart)?.t
  return Math.max(dayStart, lastPush ?? 0)
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
        try {
          // v0.15：未注入适配器时传 undefined——runner 内 getLlm(db) 每次执行按当前配置动态解析
          //（后台切换 LLM 类别/后配 key 对定时任务即时生效，无需重启；注入的 fake/适配器仍原样透传）
          await runs[key](db, { llm: llm ?? undefined })
        } catch (e) {
          logger.error(`[scheduler] ${key}:`, e.message) // 失败也推进锚点，下个周期再试
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
