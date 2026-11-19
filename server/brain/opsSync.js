// S81（v0.95，design.md K81）运营域·多维表格同步器：SQLite（真相源）→ 两张新表投影。
// 「运营数据日报」upsert 语义：无 record_id=待 create；修订行（synced_at < updated_at）按
// record_id PATCH 全量字段（对账差异与线索数同步时现算）。「用户线索」insert-only。
// 失败不阻塞调用方，下轮补推（S79-6 同构）。单选字段一律字符串值（1254062 实证，v0.94.2.2 口径）。

import { getSetting } from '../engine/settings.js'
import { listOpsPending, markOpsSynced, listLeadsPending, markLeadSynced, countLeads } from '../engine/ops.js'
import { feishuApi } from './connectors/feishu.js'

/** ops_reports 行 → 「运营数据日报」fields（数字空值不写字段；对账差异/线索数由 sync 时算好传入）。 */
export function toOpsFields(r, { diff = null, leadCount = null } = {}) {
  const f = {
    日期: Date.parse(`${r.day}T00:00:00+08:00`),
    运营账号: r.account,
    原文摘要: (r.rawSummary ?? '').slice(0, 200),
    源消息ID: r.messageId,
    来源: '群日报',
    修订次数: r.revision,
  }
  if (r.products) f.销售产品 = r.products
  if (r.reportedAmount != null) f.日报口径销售额 = r.reportedAmount
  if (diff != null) f.对账差异 = diff
  if (leadCount != null) f.线索数 = leadCount
  const nums = { 新增好友: r.newFriends, 主动触达: r.activeReach, 被动触达: r.passiveReach, 朋友圈数量: r.momentsCount, 被点赞评论互动: r.passiveInteract, 主动点赞评论互动: r.activeInteract }
  for (const [k, v] of Object.entries(nums)) if (v != null) f[k] = v
  return f
}

/** ops_leads 行 → 「用户线索」fields。 */
export function toLeadFields(l) {
  return {
    记录日期: Date.parse(`${l.day}T00:00:00+08:00`),
    运营账号: l.account || '',
    微信名: l.wechatName ?? '',
    微信号: l.wechatId ?? '',
    意向产品: l.intentProduct ?? '',
    来源渠道: l.sourceChannel ?? '',
    线索来源: l.leadSource === 'digest' ? '日终汇总' : '零散上报',
    原文: (l.rawText ?? '').slice(0, 200),
    源消息ID: l.messageId,
  }
}

/**
 * 同步运营数据（日报 upsert + 线索 insert-only）。返回 { reports: {created, updated, errors}, leads: {created, errors} }。
 * 配置不全（opsTableId/leadsTableId 空——建表前）静默跳过；单行失败不阻塞其余。
 */
export async function syncOpsToBitable(db, opts = {}) {
  const salesCfg = getSetting(db, 'sales')
  const feishuCfg = getSetting(db, 'im.feishu')
  if (!feishuCfg.appId || !salesCfg.baseToken || !salesCfg.opsTableId || !salesCfg.leadsTableId) {
    return { skipped: true, reason: 'opsTableId/leadsTableId 未配置（建表后填入 settings.sales）' }
  }
  const reports = { created: 0, updated: 0, errors: [] }
  const leads = { created: 0, errors: [] }
  const base = `/bitable/v1/apps/${salesCfg.baseToken}/tables/${salesCfg.opsTableId}/records`
  const leadBase = `/bitable/v1/apps/${salesCfg.baseToken}/tables/${salesCfg.leadsTableId}/records`
  const ridOf = (res) => res?.records?.[0]?.id ?? res?.records?.[0]?.record?.record_id

  for (const r of listOpsPending(db, { limit: opts.limit ?? 50 })) {
    try {
      // 对账差异与线索数同步时现算（真相源口径：日报额 − 当日报单实收；去重线索计数）
      const actual = db.prepare('SELECT COALESCE(SUM(amount), 0) AS s FROM sales_records WHERE deal_day = ? AND assistant = ?').get(r.day, r.account).s
      const diff = r.reportedAmount != null ? Math.round((r.reportedAmount - actual) * 100) / 100 : null
      const leadCount = countLeads(db, { day: r.day, account: r.account })
      const fields = toOpsFields(r, { diff, leadCount })
      if (!r.syncedRecordId) {
        const res = await feishuApi(feishuCfg, `${base}/batch_create`, { method: 'POST', body: { records: [{ fields }] } })
        const rid = ridOf(res)
        if (rid) { markOpsSynced(db, r.id, rid); reports.created++ }
      } else {
        await feishuApi(feishuCfg, `${base}/${r.syncedRecordId}`, { method: 'PUT', body: { fields } })
        markOpsSynced(db, r.id, r.syncedRecordId)
        reports.updated++
      }
    } catch (e) { reports.errors.push(`日报#${r.id}: ${e.message}`) }
  }

  for (const l of listLeadsPending(db, { limit: opts.leadLimit ?? 100 })) {
    try {
      const res = await feishuApi(feishuCfg, `${leadBase}/batch_create`, { method: 'POST', body: { records: [{ fields: toLeadFields(l) }] } })
      const rid = ridOf(res)
      if (rid) { markLeadSynced(db, l.id, rid); leads.created++ }
    } catch (e) { leads.errors.push(`线索#${l.id}: ${e.message}`) }
  }
  return { reports, leads }
}
