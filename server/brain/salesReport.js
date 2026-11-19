// S79（v0.94，design.md K79）销售域·每日汇总播报：今日/本月单数与金额、按小助手分布、待补发数
// 以**飞书汇总卡片**推送销售群（K41 确定性模板；卡片发送失败自动降级纯文本补发——S55 必达语义）。
// 日级幂等——当日已成功播报（scheduler_runs 有 ok 行）不重发，force 可越（S67-5 手动语义）。

import { getSetting } from '../engine/settings.js'
import { salesSummary } from '../engine/sales.js'
import { opsSummary } from '../engine/ops.js'
import { today } from '../db/time.js'
import { buildSalesDailyCard } from './bot/cards.js'
import * as feishu from './connectors/feishu.js'

const fmt = (n) => `¥${Number(n).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`

/** 降级/兜底播报文案（纯函数，与卡片三节同口径；卡片投递失败时补发）。 */
export function buildSalesReportText({ day, sales, ops }) {
  const lines = [
    `📊 销售日报 ${day}`,
    `今日成交 ${sales.today.count} 单，合计 ${fmt(sales.today.amount)}`,
    `本月累计 ${sales.month.count} 单，合计 ${fmt(sales.month.amount)}`,
  ]
  if (sales.byProduct && sales.byProduct.length) {
    lines.push('本月产品成交明细：')
    for (const p of sales.byProduct) lines.push(`  ${p.product}：${p.n} 单 ${fmt(p.amount)}`)
  }
  if (ops && ops.rows && ops.rows.length) {
    lines.push('今日运营动作：')
    const dash = (v) => (v == null ? '-' : v)
    for (const r of ops.rows) {
      lines.push(`  ${r.account}：好友${dash(r.newFriends)} 触达${dash(r.activeReach)}/${dash(r.passiveReach)} 朋友圈${dash(r.momentsCount)} 线索${r.leadCount}`)
    }
    const diffs = ops.rows.filter((r) => r.diff != null && Math.abs(r.diff) >= 0.01)
    if (diffs.length) {
      lines.push('对账（日报口径 − 报单实收）：')
      for (const r of diffs) lines.push(`  ${r.account}：日报 ${fmt(r.reportedAmount)} / 实收 ${fmt(r.actualAmount)}，差 ${fmt(Math.abs(r.diff))}`)
    }
  }
  if (sales.pendingToday > 0) lines.push(`⚠️ 今日有 ${sales.pendingToday} 条报单缺关键字段待补发`)
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
  const o = opsSummary(db, { day }) // S81：运营动作与对账（无日报数据时 rows 为空，卡片自动省节）
  const cardPayload = buildSalesDailyCard({ day, sales: s, ops: o })
  const fallbackText = buildSalesReportText({ day, sales: s, ops: o })
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
