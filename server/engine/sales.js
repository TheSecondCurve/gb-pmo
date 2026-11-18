// S79（v0.94，design.md K79）销售成交登记域·数据层：消息台账幂等、成交记录落库（业务幂等=订单号）、
// 汇总统计。与项目管理域零耦合（不产 project_events、不进 metrics.js——销售口径唯一真相源在本文件，
// routes 与 SKILL.md 不得另写销售 SQL）。

import { camelizeRows } from '../db/index.mjs'
import { today, monthStartOf } from '../db/time.js'

/** 消息台账幂等插入：message_id 已存在返回 null（重放/刷屏零重复，S79-2），否则落行返回 id。 */
export function recordSalesMessage(db, { messageId, chatId, speakerId = '', text = '', ts, status = 'noise', detail = '' }) {
  try {
    const r = db.prepare(
      `INSERT INTO sales_messages (message_id, chat_id, speaker_id, text, ts, status, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(messageId, chatId, speakerId, text, ts, status, detail, Date.now())
    return Number(r.lastInsertRowid)
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return null
    throw e
  }
}

export function updateSalesMessageStatus(db, id, status, detail = '') {
  db.prepare('UPDATE sales_messages SET status = ?, detail = ? WHERE id = ?').run(status, detail, id)
}

/** 游标：销售群已处理消息的最大秒（fetchMessages 的 cursor 语义 = 上一批最后一条创建秒；空表=首启回看 7 天）。 */
export function salesCursor(db, chatId) {
  const r = db.prepare('SELECT MAX(ts) AS t FROM sales_messages WHERE chat_id = ?').get(chatId)
  return r?.t ? Math.floor(r.t / 1000) : null
}

/** 业务查重（S79-2）：订单号是强业务键——有订单号只认订单号（未命中即新单，不走组合键防误伤：
 *  同客户同日同金额是常见复购场景）；无订单号才按 客户昵称+成交日+金额 组合查重
 *  （组合键只对库内无订单号记录——迁移/人工数据——生效）。 */
export function findSalesDuplicate(db, rec) {
  if (rec.orderNo) {
    return db.prepare('SELECT id, message_id FROM sales_records WHERE order_no = ?').get(rec.orderNo) || null
  }
  if (rec.customerNick) {
    return db.prepare(
      'SELECT id, message_id FROM sales_records WHERE order_no = \'\' AND customer_nick = ? AND deal_day = ? AND amount = ?'
    ).get(rec.customerNick, rec.dealDay, rec.amount) || null
  }
  return null
}

/** 成交记录落库（调用方已完成查重与关键字段校验；订单号冲突由唯一索引兜底抛错；可选字段 ?? '' 归一）。 */
export function insertSalesRecord(db, rec) {
  const r = db.prepare(
    `INSERT INTO sales_records
     (message_id, order_no, deal_day, deal_ts, amount, product, assistant, customer_nick, customer_name,
      customer_phone, pay_platform, trade_no, self_owned, distribution, note, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    rec.messageId, rec.orderNo ?? '', rec.dealDay, rec.dealTs, rec.amount, rec.product ?? '', rec.assistant ?? '',
    rec.customerNick ?? '', rec.customerName ?? '', rec.customerPhone ?? '', rec.payPlatform ?? '', rec.tradeNo ?? '',
    rec.selfOwned ?? '', rec.distribution ?? '', rec.note ?? '', rec.source ?? 'bot', Date.now()
  )
  return Number(r.lastInsertRowid)
}

export function listSalesRecords(db, { fromDay, toDay, limit = 200 } = {}) {
  const conds = []
  const args = []
  if (fromDay) { conds.push('deal_day >= ?'); args.push(fromDay) }
  if (toDay) { conds.push('deal_day <= ?'); args.push(toDay) }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
  return camelizeRows(db.prepare(
    `SELECT * FROM sales_records ${where} ORDER BY deal_day DESC, id DESC LIMIT ?`
  ).all(...args, Math.min(Math.max(limit, 1), 1000)))
}

export function markSalesSynced(db, id, recordId) {
  db.prepare('UPDATE sales_records SET synced_record_id = ?, synced_at = ? WHERE id = ?').run(recordId, Date.now(), id)
}

/** 未同步行（S79-6 补推口径：synced_record_id IS NULL，按落库顺序）。 */
export function listUnsyncedSalesRecords(db, { limit = 50 } = {}) {
  return camelizeRows(db.prepare(
    'SELECT * FROM sales_records WHERE synced_record_id IS NULL ORDER BY id LIMIT ?'
  ).all(Math.min(Math.max(limit, 1), 200)))
}

/**
 * 汇总统计（S79-5）：全部从 sales_records 计算，北京日界（S19）。
 * day 缺省今天；今日/本月单数与金额、按小助手分布、待补发数（当日 pending_fields 计数）。
 */
export function salesSummary(db, { day = today() } = {}) {
  const monthStart = monthStartOf(day)
  const one = (sql, ...args) => db.prepare(sql).get(...args)
  const t = one(
    'SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS amount FROM sales_records WHERE deal_day = ?'
  , day)
  const m = one(
    'SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS amount FROM sales_records WHERE deal_day >= ? AND deal_day <= ?'
  , monthStart, day)
  const byAssistant = camelizeRows(db.prepare(
    `SELECT assistant, COUNT(*) AS n, SUM(amount) AS amount FROM sales_records
     WHERE deal_day >= ? AND deal_day <= ? GROUP BY assistant ORDER BY amount DESC`
  ).all(monthStart, day)).map((r) => ({ ...r, assistant: r.assistant || '（未填）' }))
  // 本月按产品成交明细（S79-5 用户拍板：日报展示产品分布，不做小助手排行；本月累计的分解口径）
  const byProduct = camelizeRows(db.prepare(
    `SELECT product, COUNT(*) AS n, SUM(amount) AS amount FROM sales_records
     WHERE deal_day >= ? AND deal_day <= ? GROUP BY product ORDER BY amount DESC`
  ).all(monthStart, day)).map((r) => ({ ...r, product: r.product || '（未填）' }))
  // 待补发数按「今日」窗口（北京日零点起）：sales_messages.ts 是 epoch 毫秒
  const dayStartMs = Date.parse(`${day}T00:00:00+08:00`)
  const nextDayMs = dayStartMs + 86400000
  const pendingToday = one(
    'SELECT COUNT(*) AS n FROM sales_messages WHERE status = \'pending_fields\' AND ts >= ? AND ts < ?'
  , dayStartMs, nextDayMs).n
  return {
    day,
    monthStart,
    today: { count: t.n, amount: t.amount },
    month: { count: m.n, amount: m.amount },
    byAssistant,
    byProduct,
    pendingToday,
  }
}
