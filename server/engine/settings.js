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
    for (const k of ['extractionCron', 'alertCron', 'reportCron', 'calendarSyncCron', 'backupCron', 'digestCron']) {
      if (value?.[k] === undefined) continue
      parseCron(value[k]) // 非法即 throw（statusCode 400，含字段与原因）
    }
    for (const k of ['extractionEnabled', 'alertEnabled', 'reportEnabled', 'calendarSyncEnabled', 'backupEnabled', 'digestEnabled']) {
      if (value?.[k] === undefined) continue
      if (typeof value[k] !== 'boolean') {
        throw Object.assign(new Error(`scheduler.${k} 须为布尔值（true/false）`), { statusCode: 400 })
      }
    }
  },
  // S17-11（v0.14）：LLM 类别枚举校验；baseUrl/model 不强校验（归一化见 NORMALIZERS.llm）
  // S40（v0.43）：timeoutMs 1s~600s 整数边界（防呆；GLM 大 JSON 实测需 ~120s，见 K22）
  llm(value) {
    if (value?.provider !== undefined && !LLM_PROVIDERS[value.provider]) {
      throw Object.assign(new Error(`llm.provider 须为 ${Object.keys(LLM_PROVIDERS).join(' / ')}`), { statusCode: 400 })
    }
    if (value?.timeoutMs !== undefined && (!Number.isInteger(value.timeoutMs) || value.timeoutMs < 1000 || value.timeoutMs > 600000)) {
      throw Object.assign(new Error('llm.timeoutMs 须为 1000~600000 的整数（毫秒）'), { statusCode: 400 })
    }
  },
  // S24（v0.16）：AI 助手每日指令限额（正整数）
  chat(value) {
    if (value?.quotaPerDay !== undefined && (!Number.isInteger(value.quotaPerDay) || value.quotaPerDay < 0)) {
      throw Object.assign(new Error('chat.quotaPerDay 须为非负整数'), { statusCode: 400 })
    }
  },
  // S20-13/14（v0.23）：机器人多轮上下文——条数 0~24（0=关闭记忆），空闲窗 1~1440 分钟；S20-19 占位反馈布尔
  'im.feishu'(value) {
    if (value?.contextTurns !== undefined && (!Number.isInteger(value.contextTurns) || value.contextTurns < 0 || value.contextTurns > 24)) {
      throw Object.assign(new Error('im.feishu.contextTurns 须为 0~24 的整数（0=关闭多轮记忆）'), { statusCode: 400 })
    }
    if (value?.contextIdleMinutes !== undefined && (!Number.isInteger(value.contextIdleMinutes) || value.contextIdleMinutes < 1 || value.contextIdleMinutes > 1440)) {
      throw Object.assign(new Error('im.feishu.contextIdleMinutes 须为 1~1440 的整数（分钟）'), { statusCode: 400 })
    }
    if (value?.typingFeedback !== undefined && typeof value.typingFeedback !== 'boolean') {
      throw Object.assign(new Error('im.feishu.typingFeedback 须为布尔值（true/false）'), { statusCode: 400 })
    }
  },
  // S26（v0.19）：诊断台——shell 开关布尔；超时 1~60 秒；输出上限 1KB~1MB
  debug(value) {
    if (value?.shellEnabled !== undefined && typeof value.shellEnabled !== 'boolean') {
      throw Object.assign(new Error('debug.shellEnabled 须为布尔值（true/false）'), { statusCode: 400 })
    }
    if (value?.timeoutMs !== undefined && (!Number.isInteger(value.timeoutMs) || value.timeoutMs < 1000 || value.timeoutMs > 60000)) {
      throw Object.assign(new Error('debug.timeoutMs 须为 1000~60000 的整数（毫秒）'), { statusCode: 400 })
    }
    if (value?.maxOutputBytes !== undefined && (!Number.isInteger(value.maxOutputBytes) || value.maxOutputBytes < 1024 || value.maxOutputBytes > 1048576)) {
      throw Object.assign(new Error('debug.maxOutputBytes 须为 1024~1048576 的整数（字节）'), { statusCode: 400 })
    }
  },
  // S34（v0.35）：备份存储——endpoint 须完整 http(s) URL；keepCount 1~365；pathStyle 布尔。
  // 四项完整性（endpoint/bucket/accessKeyId/secretAccessKey）不在此拦——测试连接/执行时判定并回原因（S22 同构）。
  backup(value) {
    if (value?.endpoint !== undefined && value.endpoint !== '' && !/^https?:\/\/.+\..+/.test(String(value.endpoint))) {
      throw Object.assign(
        new Error('backup.endpoint 须为完整 http(s) URL（如 https://oss-cn-hangzhou.aliyuncs.com 或 https://<accountId>.r2.cloudflarestorage.com）'),
        { statusCode: 400 }
      )
    }
    if (value?.keepCount !== undefined && (!Number.isInteger(value.keepCount) || value.keepCount < 1 || value.keepCount > 365)) {
      throw Object.assign(new Error('backup.keepCount 须为 1~365 的整数（云端保留份数）'), { statusCode: 400 })
    }
    if (value?.pathStyle !== undefined && typeof value.pathStyle !== 'boolean') {
      throw Object.assign(new Error('backup.pathStyle 须为布尔值（MinIO/自建 S3 多为 true；OSS/R2 用 false）'), { statusCode: 400 })
    }
  },
}

// 保存前归一化（按 key，整体重写 value）：v0.15 起 llm 按类别分开存储——写入只作用于目标类别的子配置
// （apiKey 未传=沿用该类别已存；baseUrl/model 空或等于别的类别默认时回填本类别默认，自定义值保留），
// 其他类别的子配置原样保留（切换互不覆盖），provider 显式落库。
const NORMALIZERS = {
  // S34（v0.35）：备份对象前缀归一化——去首斜杠、补尾斜杠（空=桶根保持空）
  backup(value) {
    if (!value || typeof value !== 'object' || value.prefix === undefined) return
    const p = String(value.prefix ?? '').trim().replace(/^\/+/, '')
    value.prefix = p && !p.endsWith('/') ? `${p}/` : p
  },
  llm(value, prev) {
    if (!value || typeof value !== 'object') return
    const provider = value.provider ?? prev?.provider ?? DEFAULT_SETTINGS.llm.provider
    const out = { provider }
    for (const [key, meta] of Object.entries(LLM_PROVIDERS)) {
      const prevSub = prev?.[key] ?? {}
      if (key !== provider) {
        out[key] = { apiKey: prevSub.apiKey ?? '', baseUrl: prevSub.baseUrl ?? meta.baseUrl, model: prevSub.model ?? meta.model }
        continue
      }
      const isOthersDefault = (field, cur) => Object.entries(LLM_PROVIDERS).some(([k, m]) => k !== key && m[field] === cur)
      const resolve = (field, given, prevVal) => {
        const cur = given ?? prevVal
        return (!cur || isOthersDefault(field, cur)) ? meta[field] : cur
      }
      out[key] = {
        apiKey: value.apiKey ?? prevSub.apiKey ?? '',
        baseUrl: resolve('baseUrl', value.baseUrl, prevSub.baseUrl),
        model: resolve('model', value.model, prevSub.model),
      }
    }
    out.timeoutMs = value.timeoutMs ?? prev?.timeoutMs ?? DEFAULT_SETTINGS.llm.timeoutMs
    for (const k of Object.keys(value)) delete value[k]
    Object.assign(value, out)
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
