// S79（v0.94，design.md K79）销售域·每日汇总播报：今日/本月单数与金额、按小助手分布、待补发数
// 以**飞书汇总卡片**推送销售群（K41 确定性模板；卡片发送失败自动降级纯文本补发——S55 必达语义）。
// 日级幂等——当日已成功播报（scheduler_runs 有 ok 行）不重发，force 可越（S67-5 手动语义）。

import { getSetting } from '../engine/settings.js'
import { salesSummary } from '../engine/sales.js'
import { today } from '../db/time.js'
import { buildSalesDailyCard } from './bot/cards.js'
import * as feishu from './connectors/feishu.js'

const fmt = (n) => `¥${Number(n).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`

/** 降级/兜底播报文案（纯函数，与卡片同口径；卡片投递失败时补发）。产品明细、无小助手榜（用户拍板）。 */
export function buildSalesReportText(s) {
  const lines = [
    `📊 销售日报 ${s.day}`,
    `今日成交 ${s.today.count} 单，合计 ${fmt(s.today.amount)}`,
    `本月累计 ${s.month.count} 单，合计 ${fmt(s.month.amount)}`,
  ]
  if (s.byProduct && s.byProduct.length) {
    lines.push('本月产品成交明细：')
    for (const p of s.byProduct) lines.push(`  ${p.product}：${p.n} 单 ${fmt(p.amount)}`)
  }
  if (s.pendingToday > 0) lines.push(`⚠️ 今日有 ${s.pendingToday} 条报单缺关键字段待补发`)
  return lines.join('\n')
}

/**
 * 每日汇总播报（调度器 salesReportCron / 手动触发）。
 * opts.send 双通道注入 { card, text }（测试收集/故障注入）；缺省走飞书真实投递。
 * opts.day 显式指定汇总日（缺省北京今日，S19）——同时驱动幂等窗口锚点。
 * 返回 { pushed, day, text } 或 { pushed: false, reason }；降级后仍失败上抛（调度器落台账）。
 */
export async function dailySalesReport(db, { send, force = false, day = today() } = {}) {
  const salesCfg = getSetting(db, 'sales')
  const feishuCfg = getSetting(db, 'im.feishu')
  if (!salesCfg.chatId || !feishuCfg.appId) return { pushed: false, reason: 'sales.chatId 或 im.feishu 凭证未配置' }

  const dayStartMs = Date.parse(`${day}T00:00:00+08:00`) // 北京日零点（S19；幂等窗口锚）
  if (!force) {
    const ran = db.prepare(
      `SELECT COUNT(*) AS n FROM scheduler_runs WHERE task = 'salesReport' AND ok = 1 AND created_at >= ?`
    ).get(dayStartMs).n
    if (ran > 0) return { pushed: false, reason: '今日已播报（日级幂等）' }
  }

  const s = salesSummary(db, { day })
  const cardPayload = buildSalesDailyCard(s)
  const fallbackText = buildSalesReportText(s)
  const reply = send || {
    card: (c) => feishu.sendCard(feishuCfg, salesCfg.chatId, c),
    text: (t) => feishu.sendText(feishuCfg, salesCfg.chatId, t),
  }
  try {
    await reply.card(cardPayload)
  } catch (e) {
    await reply.text(fallbackText) // 卡片失败降级纯文本（S55 必达；仍失败则上抛）
    return { pushed: true, day: s.day, text: fallbackText, degraded: true, error: e.message }
  }
  return { pushed: true, day: s.day, card: cardPayload, text: fallbackText }
}
