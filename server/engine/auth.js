import crypto from 'node:crypto'
import { camelizeRow } from '../db/index.mjs'

const SESSION_TTL_MS = 7 * 24 * 3600 * 1000
const TOKEN_TTL_DAYS = 90

// —— 密码：scrypt（K1，替代 argon2id）——

export function hashPassword(password) {
  const salt = crypto.randomBytes(16)
  const hash = crypto.scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 })
  return `s1$${salt.toString('hex')}$${hash.toString('hex')}`
}

export function verifyPassword(password, stored) {
  if (!stored) return false
  const [v, saltHex, hashHex] = stored.split('$')
  if (v !== 's1' || !saltHex || !hashHex) return false
  const hash = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 32, { N: 16384, r: 8, p: 1 })
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'))
}

// —— 会话（服务端 session + 签名 httpOnly cookie，HMAC）——

export function createSession(db, memberId) {
  const sid = crypto.randomBytes(24).toString('hex')
  const now = Date.now()
  db.prepare('INSERT INTO sessions (id, member_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
    sid, memberId, now, now + SESSION_TTL_MS
  )
  return { sid, expiresAt: now + SESSION_TTL_MS }
}

export function getSessionMember(db, sid) {
  if (!sid) return null
  const row = db
    .prepare(
      `SELECT m.*, s.expires_at AS _expires_at FROM sessions s JOIN members m ON m.id = s.member_id
       WHERE s.id = ? AND s.expires_at > ? AND m.status = 'active'`
    )
    .get(sid, Date.now())
  if (!row) return null
  delete row._expires_at
  return publicMember(camelizeRow(row))
}

export function destroySession(db, sid) {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sid)
}

export function login(db, username, password) {
  const row = db
    .prepare(`SELECT * FROM members WHERE username = ? AND status = 'active'`)
    .get(String(username || '').trim())
  if (!row || !verifyPassword(password, row.password_hash)) {
    throw Object.assign(new Error('用户名或密码错误'), { statusCode: 401 })
  }
  return { member: publicMember(camelizeRow(row)), ...createSession(db, row.id) }
}

// —— PAT（Agent 令牌：只存 hash；前缀用于展示与定位）——

export function issueToken(db, memberId, { scope = 'read', name = 'agent', ttlDays = TOKEN_TTL_DAYS } = {}) {
  const token = 'pmo_' + crypto.randomBytes(24).toString('hex')
  const tokenHash = sha256(token)
  const now = Date.now()
  const info = db
    .prepare(
      `INSERT INTO tokens (member_id, name, token_prefix, token_hash, scope, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(memberId, name, token.slice(0, 10), tokenHash, scope, now, now + ttlDays * 24 * 3600 * 1000)
  return { token, id: Number(info.lastInsertRowid), scope, expiresAt: now + ttlDays * 24 * 3600 * 1000 }
}

export function authenticateToken(db, bearer) {
  if (!bearer) return null
  const row = db
    .prepare(
      `SELECT t.*, m.status AS member_status, m.role AS member_role FROM tokens t JOIN members m ON m.id = t.member_id
       WHERE t.token_hash = ? AND t.revoked_at IS NULL AND t.expires_at > ?`
    )
    .get(sha256(bearer), Date.now())
  if (!row || row.member_status !== 'active') return null
  return { token: camelizeRow(row), member: { id: row.member_id, role: row.member_role } }
}

export function revokeToken(db, id, by) {
  db.prepare('UPDATE tokens SET revoked_at = ?, revoked_by = ? WHERE id = ? AND revoked_at IS NULL').run(
    Date.now(), by ?? null, id
  )
}

/** 禁用/离职联动：撤销该成员全部令牌（必测清单）。 */
export function revokeMemberTokens(db, memberId) {
  db.prepare('UPDATE tokens SET revoked_at = ? WHERE member_id = ? AND revoked_at IS NULL').run(Date.now(), memberId)
}

export function listTokens(db, memberId) {
  return db
    .prepare('SELECT id, member_id, name, token_prefix, scope, created_at, expires_at, revoked_at FROM tokens WHERE member_id = ? ORDER BY id DESC')
    .all(memberId)
    .map(camelizeRow)
}

// —— bootstrap：零 admin 缺密码拒启（必测清单）——

export function bootstrapAdmin(db, { username, password, name }) {
  const count = db.prepare(`SELECT COUNT(*) AS n FROM members WHERE status = 'active'`).get().n
  if (count > 0) return false
  if (!username || !password) {
    throw Object.assign(new Error('空库需先 bootstrap 管理员：设置 GB_PMO_ADMIN_USER 与 GB_PMO_ADMIN_PASS'), {
      statusCode: 500,
    })
  }
  db.prepare(
    `INSERT INTO members (name, username, password_hash, role, status, created_at, updated_at)
     VALUES (?, ?, ?, 'admin', 'active', ?, ?)`
  ).run(name || '管理员', username, hashPassword(password), Date.now(), Date.now())
  return true
}

// —— 审计 ——

export function audit(db, { memberId = null, action, objectType = null, objectId = null, detail = null }) {
  db.prepare(
    'INSERT INTO audit_logs (member_id, action, object_type, object_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(memberId, action, objectType, String(objectId ?? ''), detail ? JSON.stringify(detail) : null, Date.now())
}

// —— helpers ——

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex')
}

export function publicMember(m) {
  if (!m) return m
  const { passwordHash, ...rest } = m
  return rest
}
