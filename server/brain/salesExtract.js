// S79（v0.94，design.md K79）销售域·抽取管线：拉销售群增量消息 → 确定性模板解析（salesParser）
// → LLM 兜底非模板 → 双幂等落库 → 群回执 → 触发表格同步。复用飞书连接器（游标语义同 channels），
// 但销售群不进 channels 表（独立域，游标 = sales_messages MAX(ts) 派生）。

import { getSetting } from '../engine/settings.js'
import { getLlm, parseJsonLoose } from './llm.js'
import { parseReport, looksLikeReport, normalizeAssistant, normalizeProduct, normalizePayPlatform, normalizeYesNo, parseAmount, parseDealDate } from '../engine/salesParser.js'
import {
  recordSalesMessage, updateSalesMessageStatus, salesCursor,
  findSalesDuplicate, insertSalesRecord,
} from '../engine/sales.js'
import { today } from '../db/time.js'
import * as feishu from './connectors/feishu.js'
import { syncPendingToBitable } from './salesSync.js'

/** LLM 兜底（S79-3）：非模板但含成交语义的消息 → 结构化 JSON（同一套字段名，落库前同归一校验）。 */
async function llmFallback(llm, text, { today: todayStr }) {
  const sys = [
    '你是销售成交报单解析器。用户消息是销售群里的成交报单（可能不按模板格式）。',
    '提取字段并以 JSON 返回：{"isReport":boolean,"confidence":number,',
    '"fields":{"dealDate":"YYYY-MM-DD 或 2026年11月18日 等原样","amount":"金额原样（含万/元单位）",',
    '"orderNo":"订单号","product":"","assistant":"","customerNick":"","payPlatform":"","tradeNo":"",',
    '"selfOwned":"是/否","distribution":"是/否","note":""}}',
    '不是成交报单（闲聊/动员/目标讨论）则 {"isReport":false}。只回 JSON，不要多余文本。',
  ].join('\n')
  const raw = await llm.complete([{ role: 'system', content: sys }, { role: 'user', content: text }], { json: true })
  const parsed = parseJsonLoose(raw)
  if (!parsed || typeof parsed !== 'object' || !parsed.isReport) return null
  if (typeof parsed.confidence === 'number' && parsed.confidence < 0.6) return null
  const f = parsed.fields || {}
  return {
    dealDay: f.dealDate ? parseDealDate(f.dealDate, { today: todayStr }) : null,
    amount: f.amount != null ? parseAmount(String(f.amount)) : null,
    orderNo: String(f.orderNo ?? '').trim(),
    product: normalizeProduct(f.product),
    assistant: normalizeAssistant(f.assistant),
    customerNick: String(f.customerNick ?? '').trim(),
    customerName: String(f.customerName ?? '').trim(),
    customerPhone: String(f.customerPhone ?? '').trim().replace(/\s+/g, ''),
    payPlatform: normalizePayPlatform(f.payPlatform),
    tradeNo: String(f.tradeNo ?? '').trim(),
    voucher: '',
    selfOwned: normalizeYesNo(f.selfOwned),
    distribution: normalizeYesNo(f.distribution),
    note: String(f.note ?? '').trim(),
  }
}

function missingOf(f) {
  const missing = []
  if (!f.orderNo) missing.push('订单号')
  if (f.amount == null) missing.push('成交金额')
  if (!f.dealDay) missing.push('成交日期')
  return missing
}

/**
 * 定时/手动触发入口（调度器 / POST /api/v1/sales/trigger）。
 * opts.send 注入回执发送（测试收集；缺省走 feishu.sendText）；opts.fetchMessages 注入拉取桩。
 * 返回 { pulled, recorded, duplicates, pending, noise, llmUsed, synced }。
 */
export async function runSalesExtraction(db, { llm, send } = {}) {
  const salesCfg = getSetting(db, 'sales')
  const feishuCfg = getSetting(db, 'im.feishu')
  if (!salesCfg.chatId || !feishuCfg.appId || !feishuCfg.appSecret) {
    return { skipped: true, reason: 'sales.chatId 或 im.feishu 凭证未配置' }
  }
  const reply = send || ((text) => feishu.sendText(feishuCfg, salesCfg.chatId, text))
  const cursor = salesCursor(db, salesCfg.chatId)
  const { messages } = await feishu.fetchMessages(feishuCfg, { groupKey: salesCfg.chatId }, cursor)
  const out = { pulled: messages.length, recorded: 0, duplicates: 0, pending: 0, noise: 0, llmUsed: 0 }
  const todayStr = today() // 北京日（S19；相对日期「今天/昨天」的锚）

  for (const msg of messages) {
    const text = String(msg.text ?? '').trim()
    const base = { messageId: msg.id, chatId: salesCfg.chatId, speakerId: msg.speakerId ?? '', text, ts: msg.ts }
    if (!text) { recordSalesMessage(db, { ...base, status: 'noise', detail: '空文本（图片/卡片等）' }); out.noise++; continue }
    const rowId = recordSalesMessage(db, { ...base, status: 'noise' })
    if (!rowId) continue // message_id 幂等：重放/刷屏零重复（S79-2）

    const parsed = parseReport(text, { today: todayStr })
    let fields = parsed.matched ? parsed.fields : null
    let missing = parsed.matched ? parsed.missing : []

    // 模板结构未命中但含报单强信号 → LLM 兜底（S79-3；llm 未配置则按噪音，不阻塞）
    if (!parsed.matched && looksLikeReport(text)) {
      const adapter = getLlm(db, llm, { purpose: 'extraction' })
      if (adapter) {
        try {
          out.llmUsed++
          const f = await llmFallback(adapter, text, { today: todayStr })
          if (f) { fields = f; missing = missingOf(f) }
        } catch { /* 兜底失败按噪音处理，不阻塞后续消息 */ }
      }
    }

    if (!fields) { out.noise++; continue } // 噪音：无结构无强信号，或 LLM 判非报单/兜底失败

    // 业务查重前置（S79-2）：同一订单的残缺重发/刷屏一律判重（静默——重复不回执，台账留痕）
    const dup = findSalesDuplicate(db, fields)
    if (dup) {
      updateSalesMessageStatus(db, rowId, 'duplicate', `与记录 #${dup.id} 重复（源消息 ${dup.message_id}）`)
      out.duplicates++
      continue
    }

    if (missing.length) {
      // 只有模板结构命中或 LLM 判定为报单才提醒补发（S79-4）；防误扰闸门在此收口
      updateSalesMessageStatus(db, rowId, 'pending_fields', `缺 ${missing.join('/')}`)
      out.pending++
      await reply(`⚠️ 收到一条疑似报单但缺关键字段（${missing.join('、')}），请按模板补发完整报单～`)
      continue
    }

    const dealTs = Date.parse(`${fields.dealDay}T00:00:00+08:00`)
    const id = insertSalesRecord(db, { ...fields, dealTs, messageId: msg.id, source: 'bot' })
    updateSalesMessageStatus(db, rowId, 'recorded', `记录 #${id}`)
    out.recorded++
  }

  // 轮末汇总回执（S79-4 回执语义）：有新成交发一条恭喜、无新成交静默零打扰（不逐条刷屏）
  if (out.recorded > 0) await reply(`收到 ${out.recorded} 条成交信息入库，恭喜！`)

  // 表格同步（best-effort：失败不阻塞，下轮补推）
  try {
    const sync = await syncPendingToBitable(db)
    out.synced = sync.synced
    if (sync.error) out.syncError = sync.error
  } catch (e) {
    out.syncError = e.message
  }
  return out // 游标由 sales_messages MAX(ts) 派生，无需另行落库
}
