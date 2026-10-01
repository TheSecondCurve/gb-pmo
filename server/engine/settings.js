import { DEFAULT_SETTINGS, LLM_PROVIDERS } from './enums.js'
import { parseCron } from './cron.js'

/** 读配置：与默认值深合并（配置台只存覆盖项）。 */
export function getSetting(db, key) {
  if (!(key in DEFAULT_SETTINGS)) throw new Error(`unknown setting key: ${key}`)
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key)
  const base = JSON.parse(JSON.stringify(DEFAULT_SETTINGS[key]))
  if (!row) return base
  return deepMerge(base, JSON.parse(row.value))
}

// 值校验器（按 key）：保存前拦截非法值，中文错误带 400。
const VALIDATORS = {
  scheduler(value) {
    for (const k of ['extractionCron', 'alertCron', 'reportCron', 'calendarSyncCron']) {
      if (value?.[k] === undefined) continue
      parseCron(value[k]) // 非法即 throw（statusCode 400，含字段与原因）
    }
    for (const k of ['extractionEnabled', 'alertEnabled', 'reportEnabled', 'calendarSyncEnabled']) {
      if (value?.[k] === undefined) continue
      if (typeof value[k] !== 'boolean') {
        throw Object.assign(new Error(`scheduler.${k} 须为布尔值（true/false）`), { statusCode: 400 })
      }
    }
  },
  // S17-11（v0.14）：LLM 类别枚举校验；baseUrl/model 不强校验（归一化见 NORMALIZERS.llm）
  llm(value) {
    if (value?.provider !== undefined && !LLM_PROVIDERS[value.provider]) {
      throw Object.assign(new Error(`llm.provider 须为 ${Object.keys(LLM_PROVIDERS).join(' / ')}`), { statusCode: 400 })
    }
  },
}

// 保存前归一化（按 key，可原地改 value）：llm 的 baseUrl/model 随类别走——
// 未显式给值、或当前值是「别的类别的默认」时，回填目标类别默认；用户自定义值（非任何类别默认）保留。
const NORMALIZERS = {
  llm(value, prev) {
    if (!value || typeof value !== 'object') return
    const provider = value.provider ?? prev?.provider ?? DEFAULT_SETTINGS.llm.provider
    const meta = LLM_PROVIDERS[provider] ?? LLM_PROVIDERS[DEFAULT_SETTINGS.llm.provider]
    value.provider = provider // 解析出的有效类别显式落库，存库行自洽（读取不再依赖默认值合并）
    for (const field of ['baseUrl', 'model']) {
      const current = value[field] ?? prev?.[field]
      const othersDefault = Object.entries(LLM_PROVIDERS).some(([k, p]) => k !== provider && p[field] === current)
      value[field] = (!current || othersDefault) ? meta[field] : current
    }
  },
}

export function setSetting(db, key, value, by) {
  if (!(key in DEFAULT_SETTINGS)) {
    throw Object.assign(new Error(`unknown setting key: ${key}`), { statusCode: 400 })
  }
  VALIDATORS[key]?.(value)
  const prevRow = db.prepare('SELECT value FROM settings WHERE key = ?').get(key)
  NORMALIZERS[key]?.(value, prevRow ? JSON.parse(prevRow.value) : undefined)
  db.prepare(
    `INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`
  ).run(key, JSON.stringify(value), Date.now(), by ?? null)
  return getSetting(db, key)
}

export function getAllSettings(db) {
  const out = {}
  for (const key of Object.keys(DEFAULT_SETTINGS)) out[key] = getSetting(db, key)
  const rows = db.prepare('SELECT key, updated_at FROM settings').all()
  out._updatedAt = Object.fromEntries(rows.map((r) => [r.key, r.updated_at]))
  return out
}

function deepMerge(base, patch) {
  if (patch === null || patch === undefined) return base
  if (typeof base !== 'object' || typeof patch !== 'object' || Array.isArray(base) || Array.isArray(patch)) {
    return patch
  }
  const out = { ...base }
  for (const [k, v] of Object.entries(patch)) out[k] = k in base ? deepMerge(base[k], v) : v
  return out
}
