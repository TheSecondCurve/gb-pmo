// 调度器：抽取（每小时）、预警（每 15 分钟）、日报（到点触发）、建议超时过期。
// 仅 index.mjs 在 ENABLE_SCHEDULER=1 时启动；测试不启动。

export function startScheduler(db, { llm = null, logger = console } = {}) {
  const timers = []

  timers.push(setInterval(() => {
    import('./extract.js').then((m) => m.runExtraction(db, {}, { llm })).catch((e) => logger.error('[scheduler] extraction:', e.message))
  }, 60 * 60 * 1000))

  timers.push(setInterval(() => {
    import('./alert.js').then((m) => m.evaluateAlerts(db)).catch((e) => logger.error('[scheduler] alerts:', e.message))
  }, 15 * 60 * 1000))

  // 日报：每 10 分钟检查一次是否已过当日推送时点且今日未发（按 pushes 当日记录去重）
  timers.push(setInterval(() => {
    import('./report.js')
      .then((m) => m.dailyReport(db))
      .then((r) => r.skipped || logger.log('[scheduler] daily report sent:', r.reports))
      .catch((e) => logger.error('[scheduler] report:', e.message))
  }, 10 * 60 * 1000))

  const stop = () => timers.forEach(clearInterval)
  return { stop }
}
