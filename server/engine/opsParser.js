// S81（v0.95，design.md K81）运营动作解析器：日终汇总（模板字段 + 线索区块）与零散线索。
// 纯函数无 LLM 无 db。用户拍板：零散线索无法拟模板、**接受信息不全**——能提多少存多少、
// 缺就空、不猜不拦；口语形态由 brain/salesExtract.js 走 LLM 兜底（结果回本模块同归一）。

import { today, addDays, isCalendarDay } from '../db/time.js'
import { normalizeAssistant, parseAmount } from './salesParser.js'

// —— 数字指标归一：剥「人/位/条/次/个/单」等单位与全角数字容错 → 非负整数；无法解析 null ——

export function parseCount(raw) {
  const s = String(raw ?? '').replace(/[人位条次个单笔]\s*/g, '').replace(/[,，\s]/g, '').trim()
  if (!s) return null
  const n = Number(s)
  return Number.isInteger(n) && n >= 0 ? n : (Number.isFinite(n) && n >= 0 ? Math.round(n) : null)
}

// —— 日终汇总字段（模板别名，长名优先） ——

const OPS_FIELD_ALIASES = {
  day: ['日期'],
  account: ['运营账号', '助手号', '账号'],
  reportedAmount: ['当日销售总金额', '当日销售金额', '销售总金额'],
  products: ['销售产品'],
  newFriends: ['新增好友', '新增好友数'],
  passiveReach: ['被动触达用户', '被动触达'],
  activeReach: ['主动触达用户', '主动触达'],
  momentsCount: ['朋友圈数量', '朋友圈条数', '朋友圈'],
  passiveInteract: ['被点赞评论互动', '被点赞评论', '被互动'],
  activeInteract: ['主动点赞评论互动', '主动点赞评论', '主动互动'],
}
const OPS_MATCHERS = Object.entries(OPS_FIELD_ALIASES)
  .flatMap(([key, aliases]) => aliases.map((a) => [a, key]))
  .sort((a, b) => b[0].length - a[0].length)
  .map(([alias, key]) => [new RegExp(`^\\s*${alias}\\s*[:：]\\s*(.*)$`), key])

const OPS_LEADS_HEADER = /^\s*用户线索/

/** 日期归一复用报单口径（今天/昨天/中文日期等）——直接内联同款规则（salesParser 未导出 parseDealDate? 已导出）。 */
export { parseDealDate } from './salesParser.js'

/** 日终汇总特征（S81-1 分流）：标题词或 ≥3 个日报字段行。 */
export function looksLikeOpsReport(text) {
  const s = String(text ?? '')
  if (!s.trim()) return false
  if (/运营数据|每日汇报|助手号/.test(s)) return true
  let n = 0
  for (const line of s.split(/\n/)) {
    for (const [re] of OPS_MATCHERS) if (re.test(line)) { n++; break }
  }
  return n >= 3
}

/** 零散线索特征：「线索」+ 可提取子字段（微信名/微信号/意向/来源任一字段行或分隔串）。 */
export function looksLikeLeadsMessage(text) {
  const s = String(text ?? '')
  if (!/线索/.test(s)) return false
  if (/微信名|微信号|意向产品|意向|来源渠道|来源/.test(s)) return true
  // 无字段词但有「线索」+多段分隔（宽容形态：线索一个：xxx，wx_xxx，想要下午茶，来自小红书）
  return /线索.{0,8}[：:]/.test(s) && s.split(/[，,、]/).length >= 3 // 「线索一个：」「线索：」等引导语宽容
}

/** 解析一条线索子串（编号行或字段行）：分隔宽容（、，,／/|-与空格混用），能提多少提多少。 */
export function parseLeadLine(line) {
  const raw = String(line ?? '').replace(/^\s*\d+\s*[.、）)]\s*/, '').trim() // 剥编号前缀
  if (!raw) return null
  const out = { wechatName: '', wechatId: '', intentProduct: '', sourceChannel: '', rawText: raw.slice(0, 200) }
  // 字段词锚定：微信名：xxx / 微信号：xxx / 意向：xxx / 来源：xxx（行内任意位置）
  const grab = (re) => { const m = raw.match(re); return m ? m[1].trim().slice(0, 60) : '' }
  out.wechatName = grab(/(?:微信名|昵称)[：:]\s*([^，,、|/\s]+)/)
  out.wechatId = grab(/(?:微信号|vx号?|wx)[：:]\s*([A-Za-z0-9_-]+)/i)
  out.intentProduct = grab(/(?:意向产品|意向)[：:]\s*([^，,、|/]+)/)
  out.sourceChannel = grab(/(?:来源渠道|渠道|来自)[：:]?\s*([^，,、|/]+)/)
  if (out.wechatName || out.wechatId) return out
  // 无字段词：按分隔切片启发——含微信号特征（字母开头带数字/_-，或 wx 前缀）的切片为 id；
  // 含「来自/渠道」段为来源；首片为微信名；其余并入意向
  const parts = raw.split(/[，,、|/\s]+/).map((x) => x.trim()).filter(Boolean) // 空格也是分隔（群消息常见）
  if (parts.length < 2) {
    if (parts.length === 1) return { ...out, wechatName: parts[0].slice(0, 60) }
    return out.wechatName || out.wechatId ? out : null
  }
  out.wechatName = parts[0].slice(0, 60)
  const rest = parts.slice(1)
  const idxFrom = rest.findIndex((x) => /来自|渠道/.test(x))
  if (idxFrom >= 0) out.sourceChannel = rest[idxFrom].replace(/^(来自|渠道)[：:]?\s*/, '').slice(0, 60)
  const candidates = rest.filter((_, i) => i !== idxFrom)
  const idPart = candidates.find((x) => /^[A-Za-z][A-Za-z0-9_-]{4,}$/.test(x))
    ?? candidates.find((x) => /^(wx|vx)[-_:]?[A-Za-z0-9_-]{3,}$/i.test(x))
  if (idPart) out.wechatId = idPart.replace(/^(wx|vx)[-_:]?/i, '')
  const intentParts = candidates.filter((x) => x !== idPart)
  if (intentParts.length) out.intentProduct = intentParts.join('、').slice(0, 80)
  return out
}

/**
 * 解析日终汇总（确定性，无 LLM）。
 * 返回 { matched, fields, leads, missing }：
 * - fields：day（北京日）/account（名册归一）/reportedAmount（元，对账口径）+ 六项指标（非负整数或 null）
 * - leads：线索区块条目（已 parseLeadLine；可能为空数组）
 * - missing：关键字段（account/day）缺失清单——非空则 pending 提醒（S81-2）
 */
export function parseOpsReport(text, opts = {}) {
  const s = String(text ?? '')
  const raw = {}
  const leadLines = []
  let inLeads = false
  for (const line of s.split(/\n/)) {
    if (OPS_LEADS_HEADER.test(line)) { inLeads = true; continue }
    let matchedField = false
    for (const [re, key] of OPS_MATCHERS) {
      const m = line.match(re)
      if (m) { raw[key] = m[1].trim(); matchedField = true; break }
    }
    if (matchedField) { inLeads = false; continue } // 线索区块遇已知字段行即结束
    if (inLeads && /\S/.test(line) && !/^[-—=]{3,}$/.test(line)) leadLines.push(line)
  }
  const fieldLineCount = Object.keys(raw).length
  const matched = /运营数据|每日汇报|助手号/.test(s) || fieldLineCount >= 3
  if (!matched) return { matched: false, fields: null, leads: [], missing: [], fieldLineCount }

  const todayStr = opts.today ?? today()
  const fields = {
    day: raw.day !== undefined ? parseOpsDay(raw.day, todayStr) : null,
    account: normalizeAssistant(raw.account),
    reportedAmount: raw.reportedAmount !== undefined ? parseAmount(raw.reportedAmount) : null,
    products: String(raw.products ?? '').trim(),
    newFriends: raw.newFriends !== undefined ? parseCount(raw.newFriends) : null,
    passiveReach: raw.passiveReach !== undefined ? parseCount(raw.passiveReach) : null,
    activeReach: raw.activeReach !== undefined ? parseCount(raw.activeReach) : null,
    momentsCount: raw.momentsCount !== undefined ? parseCount(raw.momentsCount) : null,
    passiveInteract: raw.passiveInteract !== undefined ? parseCount(raw.passiveInteract) : null,
    activeInteract: raw.activeInteract !== undefined ? parseCount(raw.activeInteract) : null,
  }
  const missing = []
  if (!fields.account) missing.push('运营账号')
  if (!fields.day) missing.push('日期')
  const leads = leadLines.map(parseLeadLine).filter(Boolean)
  return { matched: true, fields, leads, missing, fieldLineCount }
}

/** 日报日期归一：复用报单相对词与多形态（今天/昨天/2026年11月19日/11-19…）。 */
function parseOpsDay(raw, todayStr) {
  const s = String(raw ?? '').trim()
  if (!s) return null
  if (s === '今天' || s === '今日' || s === '当天') return todayStr
  if (s === '昨天') return addDays(todayStr, -1)
  let m = s.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日?$/)
  if (m) { const d = `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`; return isCalendarDay(d) ? d : null }
  if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/))) { const d = `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`; return isCalendarDay(d) ? d : null }
  if ((m = s.match(/^(\d{1,2})[-/月](\d{1,2})日?$/))) { const d = `${todayStr.slice(0, 4)}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`; return isCalendarDay(d) && d <= addDays(todayStr, 1) ? d : null }
  return null
}

/**
 * 解析零散线索消息（确定性层）：行式字段（微信名：x / 微信号：x…）收集为若干条；
 * 单条口语串（线索：a，b，c）交 parseLeadLine。LLM 兜底在 brain 层，结果组装回同结构。
 */
export function parseLeadsMessage(text) {
  const s = String(text ?? '')
  const leads = []
  let current = {}
  let sawField = false
  const flush = () => {
    if (sawField && (current.wechatName || current.wechatId)) {
      leads.push({
        wechatName: current.wechatName || '', wechatId: current.wechatId || '',
        intentProduct: current.intentProduct || '', sourceChannel: current.sourceChannel || '',
        rawText: (current.raw || '').slice(0, 200),
      })
    }
    current = {}; sawField = false
  }
  for (const line of s.split(/\n/)) {
    const m = line.match(/^\s*(微信名|昵称|微信号|vx|vx号|wx|意向产品|意向|来源渠道|渠道|来源)\s*[:：]\s*(.*)$/)
    if (m) {
      const val = m[2].trim().slice(0, 60)
      if (/微信名|昵称/.test(m[1])) current.wechatName = val
      else if (/微信号|vx|wx/.test(m[1]) && /^[A-Za-z0-9_-]+$/.test(val)) current.wechatId = val
      else if (/意向/.test(m[1])) current.intentProduct = val
      else current.sourceChannel = val
      current.raw = (current.raw ? current.raw + '；' : '') + `${m[1]}:${val}`
      sawField = true
    } else if (sawField && /\S/.test(line)) {
      // 连续非字段行并入当前线索原文（多行线索）
      current.raw = (current.raw ? current.raw + '；' : '') + line.trim().slice(0, 80)
    } else if (!sawField && /线索[：:]/.test(line)) {
      const single = parseLeadLine(line.replace(/^\s*[^：:]*线索[：:]\s*/, '线索：').replace(/^线索[：:]\s*/, ''))
      if (single && (single.wechatName || single.wechatId)) leads.push(single)
    }
  }
  flush()
  return leads
}
