// S79（v0.94，design.md K79）销售域·多维表格同步器：SQLite（真相源）→ 飞书多维表格（投影）。
// 增量 batch_create，record_id 回填 synced_record_id；失败整批不回填（下轮按 NULL 补推，S79-6），
// 调用方 catch——同步失败不阻塞落库与回执。走 feishu.feishuApi（token 管理内置，应用身份）。

import { getSetting } from '../engine/settings.js'
import { listUnsyncedSalesRecords, markSalesSynced } from '../engine/sales.js'
import { feishuApi } from './connectors/feishu.js'

/** SQLite 记录 → 多维表格 fields（总表 16 字段映射；select 为单值数组、datetime 传毫秒）。 */
export function toBitableFields(rec) {
  const f = {
    客户昵称: rec.customerNick || '',
    订单编号: rec.orderNo || '',
    成交日期: rec.dealTs,
    购买产品: rec.product || '',
    成交小助手: rec.assistant || '',
    金额: rec.amount,
    客户姓名: rec.customerName || '',
    客户手机号: rec.customerPhone || '',
    备注: rec.note || '',
    源消息ID: rec.messageId,
    来源: ['群报单'],
  }
  if (rec.payPlatform) f.付款平台 = [rec.payPlatform]
  if (rec.tradeNo) f.付款交易号 = rec.tradeNo
  if (rec.selfOwned) f.是否自营产品 = [rec.selfOwned]
  if (rec.distribution) f.是否涉及分销 = [rec.distribution]
  if (!rec.orderNo && rec.note) f.备注 = rec.note
  // 凭证：v0.94 不同步附件文件，备注附源消息回溯提示（K79）
  if (rec.voucherNote) f.备注 = [f.备注, rec.voucherNote].filter(Boolean).join('；')
  return f
}

/**
 * 补推未同步行到多维表格。返回 { attempted, synced, error }；配置不全（appId/baseToken 缺）静默跳过。
 * 单批 ≤100（飞书 batch_create 上限 2000 但收敛批量降低整批失败面），失败即止（保序补推）。
 */
export async function syncPendingToBitable(db, { limit = 50, api = feishuApi } = {}) {
  const salesCfg = getSetting(db, 'sales')
  const feishuCfg = getSetting(db, 'im.feishu')
  if (!feishuCfg.appId || !feishuCfg.appSecret || !salesCfg.baseToken || !salesCfg.tableId) {
    return { attempted: 0, synced: 0, skipped: true }
  }
  const rows = listUnsyncedSalesRecords(db, { limit })
  if (!rows.length) return { attempted: 0, synced: 0 }
  try {
    const res = await api(feishuCfg, `/bitable/v1/apps/${salesCfg.baseToken}/tables/${salesCfg.tableId}/records/batch_create`, {
      method: 'POST',
      body: { records: rows.map((r) => ({ fields: toBitableFields(r) })) },
    })
    const created = res?.records || [] // feishuApi 已剥壳返回 body.data（{records:[{record:{record_id}}]}）
    let n = 0
    for (let i = 0; i < created.length && i < rows.length; i++) {
      if (created[i]?.record?.record_id) {
        markSalesSynced(db, rows[i].id, created[i].record.record_id)
        n++
      }
    }
    return { attempted: rows.length, synced: n }
  } catch (e) {
    // 失败不回填：下轮补推（S79-6）；错误上抛给调用方决定记日志
    return { attempted: rows.length, synced: 0, error: e.message }
  }
}
