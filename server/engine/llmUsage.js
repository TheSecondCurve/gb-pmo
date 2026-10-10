// S47（v0.52，K30）：LLM 用量聚合查询（管理端）。台账写入在适配层（brain/llm.js 记账包裹）。
import { camelizeRows } from '../db/index.mjs'
import { bjDayStartMs } from '../db/time.js'

const DAY = 86400000

/** 用量聚合：byPurpose（用途×调用数/token/平均耗时/失败数）+ byDay（北京日汇总）。 */
export function llmUsage(db, { days = 7 } = {}) {
  const d = Math.min(Math.max(Number(days) || 7, 1), 90)
  const since = bjDayStartMs() - (d - 1) * DAY // 含今天的近 N 个北京日（S19）
  const byPurpose = camelizeRows(
    db.prepare(
      `SELECT purpose, COUNT(*) AS calls,
              SUM(COALESCE(prompt_tokens, 0)) AS prompt_tokens,
              SUM(COALESCE(completion_tokens, 0)) AS completion_tokens,
              ROUND(AVG(duration_ms)) AS avg_duration_ms,
              SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS errors
       FROM llm_calls WHERE created_at >= ? GROUP BY purpose ORDER BY calls DESC`
    ).all(since)
  )
  const byDay = camelizeRows(
    db.prepare(
      `SELECT BJ_TODAY(created_at) AS day, COUNT(*) AS calls,
              SUM(COALESCE(prompt_tokens, 0) + COALESCE(completion_tokens, 0)) AS tokens,
              SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS errors
       FROM llm_calls WHERE created_at >= ? GROUP BY day ORDER BY day DESC`
    ).all(since)
  )
  return { days: d, byPurpose, byDay }
}
