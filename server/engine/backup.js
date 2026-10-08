// S34（v0.35）SQLite 定时异地备份：在线快照（better-sqlite3 backup API，等价 sqlite3 .backup，禁 cp 热库）
// → gzip → 上传 S3 兼容存储 → 云端滚动保留。定时挂在既有调度器（S18 任务 backup，brain/scheduler.js）；
// 存储未配全时跳过并回原因（与 S22 未初始化静默跳过同构）。恢复=下载+gunzip+起服务（db-migrations 冒烟路径），不做恢复按钮。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { getSetting } from './settings.js'
import { audit } from './auth.js'
import { s3Client } from './s3.js'
import { bjStamp } from '../db/time.js'

const PROBE_KEY = '.gb-pmo-probe.txt'
const BACKUP_NAME_RE = /^gb-pmo-\d{8}-\d{6}\.db\.gz$/ // 只认本命名规则的备份对象（滚动保留不误删他人对象）

/** 四项完整性：缺哪项回哪项名（全配全回 null）。 */
export function backupConfigError(cfg) {
  const missing = ['endpoint', 'bucket', 'accessKeyId', 'secretAccessKey'].filter((k) => !String(cfg?.[k] ?? '').trim())
  return missing.length ? missing.join(' / ') : null
}

/**
 * 测试连通性（S34-2）：HEAD 桶（可达性/存在性）→ PUT 探针对象（写权限）→ DELETE 探针（清理）。
 * 失败逐步映射为明确原因；不发成功通知类对象，探针对象落在配置前缀下且测完即删。
 */
export async function testBackupConnection(cfg, opts = {}) {
  const missing = backupConfigError(cfg)
  if (missing) return { ok: false, reason: `未配置 ${missing}：先在下方补全存储配置（或保存后再测）` }
  const client = s3Client(cfg, opts)
  const started = Date.now()
  const head = await client.headBucket()
  if (!head.ok) {
    const why = head.status === 404 ? 'bucket 不存在（核对桶名）'
      : head.status === 403 ? 'AccessKey 无该桶权限或签名被拒（核对 Secret / region / endpoint 是否匹配）'
      : head.status === 0 ? 'endpoint/网络问题' : 'endpoint/网络问题或桶不可访问'
    return { ok: false, reason: `桶不可访问（${head.error}）——${why}` }
  }
  const put = await client.put(`${cfg.prefix}${PROBE_KEY}`, Buffer.from(`gb-pmo connectivity probe ${bjStamp()}`))
  if (!put.ok) {
    return { ok: false, reason: `无写入权限（${put.error}）——检查 AccessKey 对该桶的 PutObject 权限` }
  }
  await client.del(`${cfg.prefix}${PROBE_KEY}`) // 清理失败不影响判定（下轮测试覆盖写）
  return { ok: true, durationMs: Date.now() - started }
}

/**
 * 执行一次备份：在线快照 → gzip → PUT → 云端滚动保留 → 审计。
 * 未配全：返回 { ok:false, skipped:true, reason }（不发起网络请求，S22 同构）。
 * 上传失败：throw（statusCode 502，路由层折为 200+{ok:false,reason} 走 v0.21 网关模式；调度器 catch 记日志）。
 */
export async function runBackup(db, { cfg, memberId = null, fetchImpl } = {}) {
  const conf = cfg ?? getSetting(db, 'backup')
  const missing = backupConfigError(conf)
  if (missing) {
    return { ok: false, skipped: true, reason: `备份未配置（${missing}）：配置台「运维诊断→数据库备份」` }
  }
  const client = s3Client(conf, { fetchImpl })
  const started = Date.now()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-pmo-backup-'))
  try {
    const snapFile = path.join(dir, 'snapshot.db')
    await db.backup(snapFile) // 在线快照（WAL 安全），tech-architecture 禁 cp 热库
    const gz = zlib.gzipSync(fs.readFileSync(snapFile))
    const key = `${conf.prefix}gb-pmo-${bjStamp()}.db.gz`
    const put = await client.put(key, gz)
    if (!put.ok) {
      const err = Object.assign(new Error(`备份上传失败（${put.error}）`), { statusCode: 502 })
      audit(db, { memberId, action: 'backup.run', objectType: 'backup', detail: { ok: false, error: err.message } })
      throw err
    }
    // 云端滚动保留：只统计本命名规则的备份对象，超出 keepCount 删最旧（零填充时刻戳字典序=时间序）
    let deleted = 0
    const list = await client.list(conf.prefix)
    if (list.ok) {
      const stale = list.keys
        .map((k) => k.slice(conf.prefix.length))
        .filter((name) => BACKUP_NAME_RE.test(name))
        .sort()
        .slice(0, -conf.keepCount)
      for (const name of stale) {
        const del = await client.del(`${conf.prefix}${name}`)
        if (del.ok) deleted += 1
      }
    }
    const out = { ok: true, key, bytes: gz.length, durationMs: Date.now() - started, deleted }
    audit(db, { memberId, action: 'backup.run', objectType: 'backup', objectId: key, detail: out })
    return out
  } finally {
    fs.rmSync(dir, { recursive: true, force: true }) // 快照临时目录用后即删
  }
}

/** 最近备份历史（backup.run 审计最近 10 条；memberId 空=调度器触发）。 */
export function listBackupHistory(db) {
  const rows = db
    .prepare(
      `SELECT a.detail, a.created_at, m.name AS member_name
       FROM audit_logs a LEFT JOIN members m ON m.id = a.member_id
       WHERE a.action = 'backup.run' ORDER BY a.id DESC LIMIT 10`
    )
    .all()
  return rows.map((r) => {
    let detail = {}
    try { detail = JSON.parse(r.detail || '{}') } catch { /* 脏数据不阻塞历史 */ }
    return { at: r.created_at, memberName: r.member_name ?? '调度器', ...detail }
  })
}
