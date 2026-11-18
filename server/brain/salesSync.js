// S79（v0.94，K79）销售域·多维表格同步器：SQLite（真相源）→ 飞书多维表格（投影）。
// 增量 batch_create，record_id 回填 synced_record_id；失败整批不回填（下轮按 NULL 补推，S79-6），
// 调用方 catch——同步失败不阻塞落库与回执。走 feishu.feishuApi（token 管理内置，应用身份）。
// S80（v0.94.1，K80）：凭证截图附件——create 前对位上传（下载群原图 → drive medias 直传飞书云
// 拿 file_token），已同步行按 record_id PATCH 追加；任一环节失败跳过该图不阻塞（token 留空下轮补）。

import { getSetting } from '../engine/settings.js'
import { listUnsyncedSalesRecords, markSalesSynced, listVoucherPending, getVouchers, getVoucherTokens, setVoucherTokenAt } from '../engine/sales.js'
import { feishuApi, downloadChatImage, uploadBitableFile } from './connectors/feishu.js'

/** SQLite 记录 → 多维表格 fields（总表 16 字段映射；select 为单值数组、datetime 传毫秒）。
 *  voucherTokens（S80）：对位 file_token 数组，空位过滤——「成交凭证」附件字段。 */
export function toBitableFields(rec, voucherTokens = []) {
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
    来源: '群报单',
  }
  // 单选字段传字符串：bitable v1 API 应用身份（tenant_access_token）下数组格式触发
  // 1254062 SingleSelectFieldConvFail（2026-11-18 线上二分实证：app+数组❌ / app+字符串✅ / user 两者✅）。
  // 字符串是两种身份都接受的最大公约数格式（v0.94.2.2）。
  if (rec.payPlatform) f.付款平台 = rec.payPlatform
  if (rec.tradeNo) f.付款交易号 = rec.tradeNo
  if (rec.selfOwned) f.是否自营产品 = rec.selfOwned
  if (rec.distribution) f.是否涉及分销 = rec.distribution
  const tokens = (voucherTokens || []).filter(Boolean)
  if (tokens.length) f.成交凭证 = tokens.map((t) => ({ file_token: t }))
  return f
}

/**
 * 对位上传凭证（S80-3）：vouchers[i] 空 token 才下载+上传（幂等不重传）；单图失败填 null 继续
 * （下轮补传）。返回对齐后的 token 数组。uploadVoucher 可注入（测试）。
 */
async function ensureVoucherTokens(db, feishuCfg, baseToken, rec, { downloadImage = downloadChatImage, uploadFile = uploadBitableFile } = {}) {
  const vouchers = getVouchers(db, rec.id)
  if (!vouchers.length) return []
  const tokens = getVoucherTokens(db, rec.id)
  for (let i = 0; i < vouchers.length; i++) {
    if (tokens[i]) continue // 已上传不重传
    try {
      const { bytes, contentType } = await downloadImage(feishuCfg, { messageId: vouchers[i].msgId, imageKey: vouchers[i].imageKey })
      const token = await uploadFile(feishuCfg, baseToken, { fileName: `凭证-${vouchers[i].msgId}.png`, bytes, contentType })
      setVoucherTokenAt(db, rec.id, i, token || null)
      if (token) tokens[i] = token
    } catch {
      setVoucherTokenAt(db, rec.id, i, null) // 失败记空位：下轮补传，不阻塞
    }
  }
  return getVoucherTokens(db, rec.id)
}

/**
 * 补推未同步行到多维表格。返回 { attempted, synced, error }；配置不全（appId/baseToken 缺）静默跳过。
 * 单批 ≤100（飞书 batch_create 上限 2000 但收敛批量降低整批失败面），失败即止（保序补推）。
 */
export async function syncPendingToBitable(db, opts = {}) {
  const salesCfg = getSetting(db, 'sales')
  const feishuCfg = getSetting(db, 'im.feishu')
  if (!feishuCfg.appId || !feishuCfg.appSecret || !salesCfg.baseToken || !salesCfg.tableId) {
    return { attempted: 0, synced: 0, skipped: true }
  }
  const rows = listUnsyncedSalesRecords(db, { limit: opts.limit ?? 50 })
  if (!rows.length) return { attempted: 0, synced: 0 }
  try {
    const payload = []
    for (const row of rows) {
      // S80：create 前对位上传凭证（失败跳过该图，行照常同步——其余字段不被附件拖死）
      const tokens = await ensureVoucherTokens(db, feishuCfg, salesCfg.baseToken, row, opts)
      payload.push({ fields: toBitableFields(row, tokens) })
    }
    const res = await feishuApi(feishuCfg, `/bitable/v1/apps/${salesCfg.baseToken}/tables/${salesCfg.tableId}/records/batch_create`, {
      method: 'POST',
      body: { records: payload },
    })
    const created = res?.records || [] // feishuApi 已剥壳返回 body.data；record_id 平铺在 records[i].id
    let n = 0
    for (let i = 0; i < created.length && i < rows.length; i++) {
      const rid = created[i]?.record?.record_id ?? created[i]?.id // 双形态兼容（线上实证 batch_create 返回 {id}）
      if (rid) {
        markSalesSynced(db, rows[i].id, rid)
        n++
      }
    }
    return { attempted: rows.length, synced: n }
  } catch (e) {
    // 失败不回填：下轮补推（S79-6）；错误上抛给调用方决定记日志
    return { attempted: rows.length, synced: 0, error: e.message }
  }
}

/**
 * 凭证补挂（S80-3）：已同步行后续归属到的截图——上传后按 record_id PATCH「成交凭证」。
 * 字段值整体替换语义：新旧 file_token 合并写入（不丢已挂附件）。返回 { attempted, patched, errors }。
 */
export async function syncVoucherBackfill(db, opts = {}) {
  const salesCfg = getSetting(db, 'sales')
  const feishuCfg = getSetting(db, 'im.feishu')
  if (!feishuCfg.appId || !salesCfg.baseToken || !salesCfg.tableId) return { attempted: 0, patched: 0 }
  const rows = listVoucherPending(db, { onlySynced: true, limit: opts.limit ?? 20 })
  let patched = 0
  const errors = []
  for (const row of rows) {
    try {
      const before = getVoucherTokens(db, row.id).filter(Boolean).length
      const tokens = await ensureVoucherTokens(db, feishuCfg, salesCfg.baseToken, row, opts)
      const all = tokens.filter(Boolean)
      // 无新增成功 token 不 PATCH（create 时已带过的附件不重复写；全失败/全成功齐备同理跳过）
      if (!all.length || all.length <= before) continue
      await feishuApi(feishuCfg, `/bitable/v1/apps/${salesCfg.baseToken}/tables/${salesCfg.tableId}/records/${row.syncedRecordId}`, {
        method: 'PUT',
        body: { fields: { 成交凭证: all.map((t) => ({ file_token: t })) } },
      })
      patched++
    } catch (e) {
      errors.push(`记录 #${row.id}: ${e.message}`) // 单行失败不阻塞其余
    }
  }
  return { attempted: rows.length, patched, errors }
}
