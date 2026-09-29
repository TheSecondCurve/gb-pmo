import { DEFAULT_SETTINGS } from './enums.js'

/** 读配置：与默认值深合并（配置台只存覆盖项）。 */
export function getSetting(db, key) {
  if (!(key in DEFAULT_SETTINGS)) throw new Error(`unknown setting key: ${key}`)
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key)
  const base = JSON.parse(JSON.stringify(DEFAULT_SETTINGS[key]))
  if (!row) return base
  return deepMerge(base, JSON.parse(row.value))
}

export function setSetting(db, key, value, by) {
  if (!(key in DEFAULT_SETTINGS)) {
    throw Object.assign(new Error(`unknown setting key: ${key}`), { statusCode: 400 })
  }
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
