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

/** 成交记录落库（调用方已完成查重与关键字段校验；订单号冲突由唯一索引兜底抛错；可选字段 ?? '' 归一）。
 *  vouchers（S80）：可选初始凭证引用 JSON（测试/直插路径；抽取链路经 attachVoucher 后置挂）。 */
export function insertSalesRecord(db, rec) {
  const r = db.prepare(
    `INSERT INTO sales_records
     (message_id, order_no, deal_day, deal_ts, amount, product, assistant, customer_nick, customer_name,
      customer_phone, pay_platform, trade_no, self_owned, distribution, note, source, vouchers, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    rec.messageId, rec.orderNo ?? '', rec.dealDay, rec.dealTs, rec.amount, rec.product ?? '', rec.assistant ?? '',
    rec.customerNick ?? '', rec.customerName ?? '', rec.customerPhone ?? '', rec.payPlatform ?? '', rec.tradeNo ?? '',
    rec.selfOwned ?? '', rec.distribution ?? '', rec.note ?? '', rec.source ?? 'bot', rec.vouchers ?? '[]', Date.now()
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

// —— S80（v0.94.1，K80）报单凭证截图归属与记账 ——

/** 归属时间窗：同发言人 ±10 分钟（用户拍板；报单到截图一般几十秒，10 分钟宽而不串单）。 */
export const VOUCHER_WINDOW_MS = 10 * 60 * 1000

/**
 * 截图归属（S80-2）：挂到同发言人 ±窗口内**最近的已落库报单**（sales_messages.status='recorded'
 * 的源消息，|ts 差| 最小）——双向窗口（图先文后/文先图后都认）、跨发言人不抢挂、无主静默返回 false。
 * 幂等：vouchers 源消息号查重，同图重放不重复 append。返回是否挂上。
 */
export function attachVoucher(db, { speakerId, ts, messageId, imageKey }) {
  const row = db.prepare(
    `SELECT r.id, r.vouchers FROM sales_records r
     JOIN sales_messages m ON m.message_id = r.message_id
     WHERE m.speaker_id = ? AND m.status = 'recorded' AND ABS(m.ts - ?) <= ?
     ORDER BY ABS(m.ts - ?) ASC LIMIT 1`
  ).get(speakerId, ts, VOUCHER_WINDOW_MS, ts)
  if (!row) return false
  const vouchers = JSON.parse(row.vouchers || '[]')
  if (vouchers.some((v) => v.msgId === messageId && v.imageKey === imageKey)) return true // 重放幂等
  vouchers.push({ msgId: messageId, imageKey })
  db.prepare('UPDATE sales_records SET vouchers = ? WHERE id = ?').run(JSON.stringify(vouchers), row.id)
  return true
}

/** 读取凭证引用（[{msgId, imageKey}]）。 */
export function getVouchers(db, id) {
  const row = db.prepare('SELECT vouchers FROM sales_records WHERE id = ?').get(id)
  return JSON.parse(row?.vouchers || '[]')
}

/** 已上传 file_token 对位读取（与 vouchers 等长，null=未上传成功）。 */
export function getVoucherTokens(db, id) {
  const row = db.prepare('SELECT voucher_tokens FROM sales_records WHERE id = ?').get(id)
  return JSON.parse(row?.voucher_tokens || '[]')
}

/** token 对位记账（S80-3 幂等）：index 对齐 vouchers，只填空位、已上传不覆盖。 */
export function setVoucherTokenAt(db, id, index, token) {
  const tokens = getVoucherTokens(db, id)
  while (tokens.length < index) tokens.push(null)
  tokens[index] = token ?? null
  db.prepare('UPDATE sales_records SET voucher_tokens = ? WHERE id = ?').run(JSON.stringify(tokens), id)
}

/** 附件未完成行（已同步但 tokens 未对齐 vouchers，或未同步行带图）：backfill 候选。 */
export function listVoucherPending(db, { onlySynced = false, limit = 20 } = {}) {
  const cond = onlySynced ? "synced_record_id IS NOT NULL AND" : ''
  return camelizeRows(db.prepare(
    `SELECT * FROM sales_records WHERE ${cond} vouchers != '[]' AND (
       json_array_length(vouchers) > json_array_length(voucher_tokens)
       OR voucher_tokens LIKE '%null%'
     ) ORDER BY id LIMIT ?`
  ).all(Math.min(Math.max(limit, 1), 100)))
}
