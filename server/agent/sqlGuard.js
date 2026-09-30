// SQL 护栏（S4 Agent SQL 端点与 S20 机器人 query 工具同源共享，K9）：
// 单语句判定、SELECT/WITH/VALUES 只读、DDL/PRAGMA 403、凭据列与 sessions 表双向屏蔽、
// 裸 date('now') 拦截（S19 时区）、行数截断。错误消息与原 Agent SQL 端点逐字一致（测试锚点）。

export const SQL_MAX_ROWS = 1000
export const CREDENTIAL_COLS = /password_hash|token_hash/i
export const SESSION_TABLE = /\bsessions\b/i
export const READ_HEADS = /^(SELECT|WITH|VALUES)\b/i
export const WRITE_HEADS = /^(INSERT|UPDATE|DELETE)\b/i
export const DDL_HEADS = /^(CREATE|ALTER|DROP|PRAGMA|ATTACH|DETACH|VACUUM|REINDEX)\b/i

/** 注释前缀剥离后再判定语句头，防块注释或 -- 前缀绕过。 */
export function stripSqlComments(sql) {
  return sql.replace(/^\s*(--[^\n]*\n|\/\*[\s\S]*?\*\/|\s)+/, '').trim()
}

/**
 * 语句静态检查（prepare 之前）：返回 { error: { statusCode, message, reason } } 或 { head: 'read'|'write'|null }。
 * head=null 表示既非读头也非写头（由调用方决定 403 话术）。
 */
export function inspectSql(sql) {
  if (CREDENTIAL_COLS.test(sql) || SESSION_TABLE.test(sql)) {
    return { error: { statusCode: 403, message: '禁止访问凭据列或 sessions 表', reason: 'blacklist' } }
  }
  const stripped = stripSqlComments(sql)
  if (DDL_HEADS.test(stripped)) {
    return { error: { statusCode: 403, message: 'DDL/PRAGMA 对任何令牌一律 403', reason: 'ddl' } }
  }
  // S19 时区护栏：裸 date('now')/datetime('now') 是 UTC 语义，凌晨时段会错一天；显式带时区修饰（如 '+8 hours'）放行
  if (/\b(?:date|datetime)\s*\(\s*'now'\s*\)/i.test(sql)) {
    return {
      error: {
        statusCode: 400,
        message: "date('now')/datetime('now') 为 UTC 语义（凌晨会差一天）：今天请用 BJ_TODAY()（北京时区，可传 epoch 毫秒参数），或显式写 date('now','+8 hours')",
        reason: 'utc_now',
      },
    }
  }
  const head = READ_HEADS.test(stripped) ? 'read' : WRITE_HEADS.test(stripped) ? 'write' : null
  return { head, stripped }
}

/**
 * 只读查询执行（S20 机器人 query 工具）：inspect → 只许 read 头 → prepare readonly 双条件 → 截断与结果列黑名单。
 * 错误以 statusCode Error 抛出（消息与 Agent SQL 端点一致）。
 */
export function runReadOnlyQuery(db, sql, { maxRows = SQL_MAX_ROWS } = {}) {
  if (typeof sql !== 'string' || !sql.trim()) {
    throw Object.assign(new Error('sql 必填'), { statusCode: 400 })
  }
  const insp = inspectSql(sql)
  if (insp.error) throw Object.assign(new Error(insp.error.message), { statusCode: insp.error.statusCode, reason: insp.error.reason })
  if (insp.head !== 'read') {
    throw Object.assign(new Error('仅允许只读查询（SELECT/WITH/VALUES）'), { statusCode: 403 })
  }
  let stmt
  try {
    stmt = db.prepare(sql)
  } catch (e) {
    throw Object.assign(new Error(`SQL 预编译失败: ${e.message}`), { statusCode: 400 })
  }
  if (stmt.readonly !== true || !stmt.reader) {
    throw Object.assign(new Error('仅允许只读查询（SELECT/WITH/VALUES）'), { statusCode: 403 })
  }
  let rows
  try {
    rows = stmt.all()
  } catch (e) {
    throw Object.assign(new Error(`执行失败: ${e.message}`), { statusCode: 400 })
  }
  const truncated = rows.length > maxRows
  const limited = truncated ? rows.slice(0, maxRows) : rows
  if (limited.length && Object.keys(limited[0]).some((c) => CREDENTIAL_COLS.test(c))) {
    throw Object.assign(new Error('结果包含凭据列'), { statusCode: 403 })
  }
  return { rows: limited, count: limited.length, truncated }
}
