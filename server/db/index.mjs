import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { today } from './time.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const MIGRATIONS_DIR = path.join(__dirname, 'migrations')

/**
 * 打开数据库并应用 SQLite 工程规范（tech-architecture.md）：
 * PRAGMA 只在连接层执行，不写进 migration；库文件 600。
 * 连接层注册 BJ_TODAY()（S19）：SQL 中的「今天」一律走它（北京时区，与 today() 同源），
 * 禁止裸 date('now')（UTC 语义，Agent 端点有护栏）。
 */
export function openDb(file) {
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')
  db.pragma('foreign_keys = ON')
  // varargs：BJ_TODAY() 与 BJ_TODAY(<epoch_ms>) 两种形态都合法（无参时入参为 undefined）
  db.function('BJ_TODAY', { varargs: true }, (at) => {
    if (at == null) return today()
    const d = new Date(typeof at === 'number' ? at : Number(at))
    if (Number.isNaN(d.getTime())) {
      throw new Error('BJ_TODAY 参数须为 epoch 毫秒（整数），或留空取当前北京日')
    }
    return today(d)
  })
  try {
    if (file !== ':memory:') fs.chmodSync(file, 0o600)
  } catch {
    /* 测试临时目录权限不影响 */
  }
  return db
}

/** 迁移：按文件名序执行未应用的 *.sql（幂等，可重复跑）。返回本次应用的数量。 */
export function migrate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS migrations_meta (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`)
  const applied = new Set(db.prepare('SELECT name FROM migrations_meta').all().map((r) => r.name))
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
  let count = 0
  for (const f of files) {
    if (applied.has(f)) continue
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8')
    const tx = db.transaction(() => {
      db.exec(sql)
      db.prepare('INSERT INTO migrations_meta (name, applied_at) VALUES (?, ?)').run(f, Date.now())
    })
    tx()
    count += 1
  }
  return count
}

/** 建一个已完成迁移的库（测试/启动共用）。 */
export function createDb(file) {
  const db = openDb(file)
  migrate(db)
  return db
}

// —— 行映射：SQL snake_case → JSON camelCase（AGENTS.md 编码约定）——

export function camelizeRow(row) {
  if (!row || typeof row !== 'object') return row
  const out = {}
  for (const [k, v] of Object.entries(row)) {
    const ck = k.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase())
    out[ck] = v
  }
  return out
}

export function camelizeRows(rows) {
  return rows.map(camelizeRow)
}

/** 软删/归档不物理删除（本项目语义由各状态枚举承载，见 enums.js）。 */
export const now = () => Date.now()
