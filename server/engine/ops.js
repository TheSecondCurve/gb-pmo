// S81（v0.95，design.md K81）运营动作域·数据层：日终汇总修订覆盖（账号×日）、线索去重入库、
// 小助手名册（学习/校验/反查）、运营汇总与成交对账。与项目管理域零耦合；对账只读 sales_records。

import { camelizeRows } from '../db/index.mjs'
import { today, monthStartOf } from '../db/time.js'

// —— 日终汇总（S81-2） ——

/**
 * 修订覆盖 upsert：(account, day) 唯一——不存在则建（revision=1），存在则覆盖为最新
 * （revision+1、保留 created_at）。返回 { id, created, revision, speakerChanged }：
 * speakerChanged=true 表示这次发言人 open_id 与上一版不同（调用方回执提醒，K81 温和不拦截）。
 * 修订后 synced_record_id 置空——表格侧下轮 upsert 更新既有行。
 */
export function upsertOpsReport(db, f, { messageId, speakerId = '' } = {}) {
  const now = Date.now()
  const prev = db.prepare('SELECT id, speaker_id, revision FROM ops_reports WHERE account = ? AND day = ?').get(f.account, f.day)
  if (!prev) {
    const r = db.prepare(
      `INSERT INTO ops_reports (message_id, speaker_id, account, day, reported_amount, products,
        new_friends, active_reach, passive_reach, moments_count, passive_interact, active_interact,
        raw_summary, revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
    ).run(messageId, speakerId, f.account, f.day, f.reportedAmount, f.products ?? '',
      f.newFriends ?? null, f.activeReach ?? null, f.passiveReach ?? null,
      f.momentsCount ?? null, f.passiveInteract ?? null, f.activeInteract ?? null,
      f.rawSummary ?? '', now, now)
    return { id: Number(r.lastInsertRowid), created: true, revision: 1, speakerChanged: false }
  }
  db.prepare(
    `UPDATE ops_reports SET message_id = ?, speaker_id = ?, reported_amount = ?, products = ?,
      new_friends = ?, active_reach = ?, passive_reach = ?, moments_count = ?,
      passive_interact = ?, active_interact = ?, raw_summary = ?, revision = ?, updated_at = ? WHERE id = ?`
  ).run(messageId, speakerId, f.reportedAmount, f.products ?? '',
    f.newFriends ?? null, f.activeReach ?? null, f.passiveReach ?? null,
    f.momentsCount ?? null, f.passiveInteract ?? null, f.activeInteract ?? null,
    f.rawSummary ?? '', prev.revision + 1, now, prev.id)
  // 注意：修订不清 synced_record_id——「表格已有行」信息保留；同步侧以 synced_at < updated_at 判脏走 upsert
  return { id: prev.id, created: false, revision: prev.revision + 1, speakerChanged: Boolean(prev.speaker_id) && prev.speaker_id !== speakerId }
}

/** 待同步行（S81-6）：无 record_id=待 create；synced_at < updated_at=修订待 update。 */
export function listOpsPending(db, { limit = 50 } = {}) {
  return camelizeRows(db.prepare(
    `SELECT * FROM ops_reports WHERE synced_record_id IS NULL OR synced_at < updated_at ORDER BY id LIMIT ?`
  ).all(Math.min(Math.max(limit, 1), 200)))
}

export function markOpsSynced(db, id, recordId) {
  db.prepare('UPDATE ops_reports SET synced_record_id = ?, synced_at = ? WHERE id = ?').run(recordId, Date.now(), id)
}

/** 待同步线索（insert-only；synced 后不再变）。 */
export function listLeadsPending(db, { limit = 100 } = {}) {
  return camelizeRows(db.prepare(
    'SELECT * FROM ops_leads WHERE synced_record_id IS NULL ORDER BY id LIMIT ?'
  ).all(Math.min(Math.max(limit, 1), 200)))
}

export function markLeadSynced(db, id, recordId) {
  db.prepare('UPDATE ops_leads SET synced_record_id = ? WHERE id = ?').run(recordId, id)
}

export function listOpsReports(db, { fromDay, toDay, limit = 100 } = {}) {
  const conds = []; const args = []
  if (fromDay) { conds.push('day >= ?'); args.push(fromDay) }
  if (toDay) { conds.push('day <= ?'); args.push(toDay) }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
  return camelizeRows(db.prepare(`SELECT * FROM ops_reports ${where} ORDER BY day DESC, account LIMIT ?`).all(...args, Math.min(Math.max(limit, 1), 500)))
}

// —— 线索（S81-3） ——

/**
 * 去重入库：(account, wechatId) 命中部分唯一索引则跳过（返回 null）；无微信号按
 * (account, day, wechatName) 组合查重。返回新插入 id（或 null=重复跳过）。
 */
export function insertLeadIfAbsent(db, lead, { messageId, day, account, leadSource = 'scatter' } = {}) {
  const acct = lead.account || account || ''
  if (lead.wechatId) {
    try {
      const r = db.prepare(
        `INSERT INTO ops_leads (message_id, account, day, wechat_name, wechat_id, intent_product, source_channel, lead_source, raw_text, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(messageId, acct, day, lead.wechatName ?? '', lead.wechatId, lead.intentProduct ?? '', lead.sourceChannel ?? '', leadSource, lead.rawText ?? '', Date.now())
      return Number(r.lastInsertRowid)
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) return null // (账号,微信号) 重复——日报/零散合流
      throw e
    }
  }
  if (lead.wechatName) {
    const dup = db.prepare(
      `SELECT id FROM ops_leads WHERE account = ? AND day = ? AND wechat_name = ? AND wechat_id = ''`
    ).get(acct, day, lead.wechatName)
    if (dup) return null
  }
  if (!lead.wechatName && !lead.wechatId && !lead.intentProduct) return null // 全空线索不入库
  const r = db.prepare(
    `INSERT INTO ops_leads (message_id, account, day, wechat_name, wechat_id, intent_product, source_channel, lead_source, raw_text, created_at)
     VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, ?)`
  ).run(messageId, acct, day, lead.wechatName ?? '', lead.intentProduct ?? '', lead.sourceChannel ?? '', leadSource, lead.rawText ?? '', Date.now())
  return Number(r.lastInsertRowid)
}

export function countLeads(db, { day, account } = {}) {
  const conds = []; const args = []
  if (day) { conds.push('day = ?'); args.push(day) }
  if (account) { conds.push('account = ?'); args.push(account) }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
  return db.prepare(`SELECT COUNT(*) AS n FROM ops_leads ${where}`).get(...args).n
}

// —— 名册（S81-4） ——

/** 群成员灌表（初始化/再同步）：open_id 冲突跳过；新成员名册名初值=群昵称。返回新增数。 */
export function syncAssistantsFromMembers(db, members) {
  let added = 0
  const now = Date.now()
  const ins = db.prepare(
    `INSERT INTO sales_assistants (assistant_name, open_id, display_name, status, created_at, updated_at)
     VALUES (?, ?, ?, 'candidate', ?, ?)`
  )
  for (const m of members) {
    if (!m.openId) continue
    try { ins.run(m.name || m.openId.slice(0, 16), m.openId, m.name ?? '', now, now); added++ } catch { /* 已在册 */ }
  }
  return added
}

export function listAssistants(db) {
  return camelizeRows(db.prepare('SELECT * FROM sales_assistants ORDER BY id').all())
}

export function renameAssistant(db, id, assistantName) {
  db.prepare('UPDATE sales_assistants SET assistant_name = ?, updated_at = ? WHERE id = ?').run(assistantName, Date.now(), id)
}

/** 按发言人反查名册名（零散线索归属）。 */
export function resolveAssistantByOpenId(db, openId) {
  if (!openId) return null
  return db.prepare('SELECT assistant_name FROM sales_assistants WHERE open_id = ?').get(openId)?.assistant_name ?? null
}

/**
 * 共现学习（S81-4）：报单/日报的（文本账号名， 发言人 open_id）共现——
 * 首次建立 candidate 绑定；名册中该 open_id 已是 confirmed 且名字一致则无操作；
 * confirmed 账号名下绑定的 open_id 与当前发言人不同 → 返回 'mismatch'（调用方回执提醒，不拦截）。
 */
export function learnAssistantBinding(db, { assistantName, openId }) {
  if (!assistantName || !openId) return 'skip'
  const byOpen = db.prepare('SELECT * FROM sales_assistants WHERE open_id = ?').get(openId)
  if (byOpen) {
    if (byOpen.assistant_name === assistantName) {
      if (byOpen.status === 'candidate') db.prepare(`UPDATE sales_assistants SET status = 'confirmed', bound_at = ?, updated_at = ? WHERE id = ?`).run(Date.now(), Date.now(), byOpen.id)
      return 'ok'
    }
    // 同一发言人用了别的账号名（名册名修正中/写错）——不覆盖用户配置，提示口径即可
    return byOpen.status === 'confirmed' ? 'name-differs' : 'candidate-differs'
  }
  const byName = db.prepare('SELECT * FROM sales_assistants WHERE assistant_name = ?').all(assistantName)
  const confirmedOther = byName.find((r) => r.status === 'confirmed')
  if (confirmedOther) return 'mismatch' // 该账号名已绑定其他人——代报或冒报，温和提醒
  try {
    db.prepare(
      `INSERT INTO sales_assistants (assistant_name, open_id, display_name, status, created_at, updated_at)
       VALUES (?, ?, '', 'candidate', ?, ?)`
    ).run(assistantName, openId, Date.now(), Date.now())
    return 'learned'
  } catch { return 'skip' }
}

// —— 汇总与对账（S81-5） ——

/**
 * 运营汇总（day 缺省北京今日）：各账号行（六项指标可空）+ 线索数（去重后计数）+
 * 对账（reported_amount − 当日 sales_records 实收，按名册名=assistant 匹配；报单无该账号时以日报额为差）。
 */
export function opsSummary(db, { day = today() } = {}) {
  const rows = camelizeRows(db.prepare('SELECT * FROM ops_reports WHERE day = ? ORDER BY account').all(day))
  const byAccount = rows.map((r) => {
    const leadCount = countLeads(db, { day, account: r.account })
    const actual = db.prepare(
      'SELECT COALESCE(SUM(amount), 0) AS s FROM sales_records WHERE deal_day = ? AND assistant = ?'
    ).get(day, r.account).s
    const diff = r.reportedAmount != null ? Math.round((r.reportedAmount - actual) * 100) / 100 : null
    return { account: r.account, newFriends: r.newFriends, activeReach: r.activeReach, passiveReach: r.passiveReach,
      momentsCount: r.momentsCount, passiveInteract: r.passiveInteract, activeInteract: r.activeInteract,
      reportedAmount: r.reportedAmount, actualAmount: actual, diff, leadCount, revision: r.revision }
  })
  // 未发日报但有报单/线索的账号也进表（对账与线索数口径完整）
  const extra = camelizeRows(db.prepare(
    `SELECT DISTINCT assistant AS account FROM sales_records WHERE deal_day = ? AND assistant != ''
     UNION SELECT DISTINCT account FROM ops_leads WHERE day = ? AND account != ''`
  ).all(day, day)).map((x) => x.account).filter((a) => !rows.some((r) => r.account === a))
  for (const account of extra) {
    const leadCount = countLeads(db, { day, account })
    const actual = db.prepare('SELECT COALESCE(SUM(amount), 0) AS s FROM sales_records WHERE deal_day = ? AND assistant = ?').get(day, account).s
    byAccount.push({ account, newFriends: null, activeReach: null, passiveReach: null, momentsCount: null,
      passiveInteract: null, activeInteract: null, reportedAmount: null, actualAmount: actual, diff: null, leadCount, revision: 0 })
  }
  const totals = byAccount.reduce((t, r) => ({
    newFriends: (t.newFriends ?? 0) + (r.newFriends ?? 0), activeReach: (t.activeReach ?? 0) + (r.activeReach ?? 0),
    passiveReach: (t.passiveReach ?? 0) + (r.passiveReach ?? 0), momentsCount: (t.momentsCount ?? 0) + (r.momentsCount ?? 0),
    passiveInteract: (t.passiveInteract ?? 0) + (r.passiveInteract ?? 0), activeInteract: (t.activeInteract ?? 0) + (r.activeInteract ?? 0),
    reportedAmount: (t.reportedAmount ?? 0) + (r.reportedAmount ?? 0), actualAmount: (t.actualAmount ?? 0) + r.actualAmount,
    leadCount: (t.leadCount ?? 0) + r.leadCount,
  }), {})
  return { day, monthStart: monthStartOf(day), rows: byAccount, totals }
}
