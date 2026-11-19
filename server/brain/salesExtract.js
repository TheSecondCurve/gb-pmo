// S79（v0.94，design.md K79）销售域·抽取管线：拉销售群增量消息 → 确定性模板解析（salesParser）
// → LLM 兜底非模板 → 双幂等落库 → 群回执 → 触发表格同步。复用飞书连接器（游标语义同 channels），
// 但销售群不进 channels 表（独立域，游标 = sales_messages MAX(ts) 派生）。
// S81（v0.95，K81）：一轮内三类消息分流——报单（既有）/ 日终汇总（修订覆盖+对账）/
// 零散线索（去重入库+名册反查归属）；名册共现学习横跨三类。

import { getSetting } from '../engine/settings.js'
import { getLlm, parseJsonLoose } from './llm.js'
import { parseReport, looksLikeReport, normalizeAssistant, normalizeProduct, normalizePayPlatform, normalizeYesNo, parseAmount, parseDealDate } from '../engine/salesParser.js'
import { parseOpsReport, looksLikeOpsReport, looksLikeLeadsMessage, parseLeadsMessage } from '../engine/opsParser.js'
import {
  recordSalesMessage, updateSalesMessageStatus, salesCursor,
  findSalesDuplicate, insertSalesRecord, attachVoucher,
} from '../engine/sales.js'
import {
  upsertOpsReport, insertLeadIfAbsent, resolveAssistantByOpenId,
} from '../engine/ops.js'
import { today } from '../db/time.js'
import * as feishu from './connectors/feishu.js'
import { syncPendingToBitable, syncVoucherBackfill } from './salesSync.js'
import { syncOpsToBitable } from './opsSync.js'

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

/** LLM 兜底（S81-3）：口语线索 → JSON 数组（能提多少提多少，接受不全）。 */
async function llmLeadsFallback(llm, text) {
  const sys = [
    '你是销售线索提取器。用户消息是销售群里发的用户线索（格式自由）。',
    '提取全部线索并以 JSON 数组返回：[{"wechatName":"","wechatId":"","intentProduct":"","sourceChannel":""}]',
    '字段能认出多少填多少，认不出留空字符串。消息里没有线索则返回 []。只回 JSON。',
  ].join('\n')
  const raw = await llm.complete([{ role: 'system', content: sys }, { role: 'user', content: text }], { json: true })
  const parsed = parseJsonLoose(raw)
  if (!Array.isArray(parsed)) return []
  return parsed.filter((x) => x && typeof x === 'object').map((x) => ({
    wechatName: String(x.wechatName ?? '').trim().slice(0, 60),
    wechatId: String(x.wechatId ?? '').trim().slice(0, 60),
    intentProduct: String(x.intentProduct ?? '').trim().slice(0, 80),
    sourceChannel: String(x.sourceChannel ?? '').trim().slice(0, 60),
  }))
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
  const out = { pulled: messages.length, recorded: 0, duplicates: 0, pending: 0, noise: 0, llmUsed: 0, opsReports: 0, opsRevised: 0, leads: 0 }
  const todayStr = today() // 北京日（S19；相对日期「今天/昨天」的锚）
  const images = [] // S80：本轮图片消息（纯图与图文混排都收集，第二遍归属）

  // 第一遍：三类消息分流（S81：日报 → 线索 → 报单，模板特征互斥）+ 各自落库
  for (const msg of messages) {
    const text = String(msg.text ?? '').trim()
    const hasImage = (msg.imageKeys || []).length > 0
    if (hasImage) images.push(msg) // S80：混排消息文本照常解析，图也收集
    const base = { messageId: msg.id, chatId: salesCfg.chatId, speakerId: msg.speakerId ?? '', text, ts: msg.ts }
    if (!text) {
      // 纯图片消息不落台账（S80：归属幂等靠 vouchers 查重；无图的空文本——卡片/系统消息——仍记噪音）
      if (!hasImage) { recordSalesMessage(db, { ...base, status: 'noise', detail: '空文本（卡片等）' }); out.noise++ }
      continue
    }
    const rowId = recordSalesMessage(db, { ...base, status: 'noise' })
    if (!rowId) continue // message_id 幂等：重放/刷屏零重复（S79-2）

    // —— S81-2 日终汇总：修订覆盖 + 线索区块去重并入 + 名册学习 ——
    if (looksLikeOpsReport(text)) {
      const p = parseOpsReport(text, { today: todayStr })
      if (!p.matched) { out.noise++; continue }
      if (p.missing.length) { // v0.95.2：账号不再必填（归属=发言人名册名），仅日期必填
        updateSalesMessageStatus(db, rowId, 'pending_fields', `日报缺 ${p.missing.join('/')}`)
        out.pending++
        await reply(`⚠️ 一份运营日报缺关键字段（${p.missing.join('、')}），请补发完整日报～`)
        continue
      }
      // v0.95.2（K81 修订）：日报归属 = 发言人名册名（文本「运营账号」字段降为参考）
      const owner = resolveAssistantByOpenId(db, msg.speakerId)
      const account = owner ?? p.fields.account
      const fields = { ...p.fields, account }
      const up = upsertOpsReport(db, fields, { messageId: msg.id, speakerId: msg.speakerId ?? '' })
      for (const lead of p.leads) {
        const lid = insertLeadIfAbsent(db, { ...lead, account }, { messageId: msg.id, day: p.fields.day, account, leadSource: 'digest' })
        if (lid) out.leads++
      }
      updateSalesMessageStatus(db, rowId, 'ops_report', `日报 #${up.id} r${up.revision}${up.speakerChanged ? '（换人代报）' : ''}`)
      if (up.created) out.opsReports++; else out.opsRevised++
      continue
    }

    // —— S81-3 零散线索：确定性 + LLM 兜底，去重入库；归属按发言人名册反查 ——
    if (looksLikeLeadsMessage(text) && !looksLikeReport(text)) {
      let leads = parseLeadsMessage(text)
      if (!leads.length) {
        const adapter = getLlm(db, llm, { purpose: 'extraction' })
        if (adapter) {
          try { out.llmUsed++; leads = await llmLeadsFallback(adapter, text) } catch { /* 兜底失败按噪音 */ }
        }
      }
      leads = (leads || []).filter((l) => l.wechatName || l.wechatId || l.intentProduct)
      if (!leads.length) { out.noise++; continue }
      const account = resolveAssistantByOpenId(db, msg.speakerId) ?? ''
      const leadDay = today(msg.ts)
      let n = 0
      for (const lead of leads) {
        const lid = insertLeadIfAbsent(db, { ...lead, account }, { messageId: msg.id, day: leadDay, account, leadSource: 'scatter' })
        if (lid) n++
      }
      if (!n) { // 全部与已有线索重复（如日报区块后再单发）——静默判重
        updateSalesMessageStatus(db, rowId, 'duplicate', '线索全部重复')
        out.duplicates++
        continue
      }
      updateSalesMessageStatus(db, rowId, 'ops_lead', `线索 x${n}${account ? `（${account}）` : ''}`)
      out.leads += n
      continue
    }

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

    // v0.95.2（K81 修订）：成交归属 = 发言人名册名（用户拍板「永远归发言人」）——
    // 文本「成交小助手」字段不再参与归属（照存做参考）；名册未配置回退文本名暂记
    const owner = resolveAssistantByOpenId(db, msg.speakerId)
    const assistant = owner ?? fields.assistant
    const dealTs = Date.parse(`${fields.dealDay}T00:00:00+08:00`)
    const id = insertSalesRecord(db, { ...fields, assistant, dealTs, messageId: msg.id, source: 'bot' })
    updateSalesMessageStatus(db, rowId, 'recorded', `记录 #${id}${owner ? '' : '（名册未配置，暂记文本助手名）'}`)
    out.recorded++
  }

  // 轮末汇总回执（S79-4/S81 静默哲学）：任一新数据才发一条合并回执、无事零打扰
  const bits = []
  if (out.recorded > 0) bits.push(`${out.recorded} 条成交`)
  if (out.opsReports + out.opsRevised > 0) bits.push(`${out.opsReports + out.opsRevised} 份运营日报`)
  if (out.leads > 0) bits.push(`${out.leads} 条新线索`)
  if (bits.length) await reply(`收到 ${bits.join('、')}入库，恭喜！`)

  // S80 第二遍：图片归属（本轮报单已全部落库——图先文后同轮也能挂上；无主图静默）
  let voucherAttached = 0
  for (const img of images) {
    for (const imageKey of img.imageKeys || []) {
      if (attachVoucher(db, { speakerId: img.speakerId ?? '', ts: img.ts, messageId: img.id, imageKey })) voucherAttached++
    }
  }
  out.voucherAttached = voucherAttached

  // 表格同步（best-effort：失败不阻塞，下轮补推）+ 已同步行的凭证补挂（S80-3 PATCH）
  try {
    const sync = await syncPendingToBitable(db)
    out.synced = sync.synced
    if (sync.error) out.syncError = sync.error
    const back = await syncVoucherBackfill(db)
    out.voucherPatched = back.patched
    // S81：运营两张表（日报 upsert + 线索 insert-only；未建表时静默跳过）
    const ops = await syncOpsToBitable(db)
    out.opsSynced = (ops.reports?.created ?? 0) + (ops.reports?.updated ?? 0) + (ops.leads?.created ?? 0)
    if (ops.reports?.errors?.length || ops.leads?.errors?.length) out.opsSyncError = [...(ops.reports?.errors ?? []), ...(ops.leads?.errors ?? [])].join('；').slice(0, 300)
  } catch (e) {
    out.syncError = e.message
  }
  return out // 游标由 sales_messages MAX(ts) 派生，无需另行落库
}
