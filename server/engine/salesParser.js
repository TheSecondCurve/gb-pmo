// S79（v0.94，design.md K79）销售报单确定性解析器：模板报单逐行「字段名：值」匹配 + 归一化。
// 纯函数、无 LLM 无 db——报单是结构化模板消息，确定性层覆盖 90%+（K79 决策②），
// 非模板的成交语义消息由 brain/salesExtract.js 走 LLM 兜底（结果回本模块同一套归一校验）。

import { today, addDays, dayDiff, isCalendarDay } from '../db/time.js'

// —— 名册归一（迁移存量时实证的清洗规则；归一失败保留原值，新名册自然生长）——

// 小助手名剥括号注释：「漫漫（气球）」→「漫漫」、「小光（慢持）」→「小光」
export function normalizeAssistant(raw) {
  const s = String(raw ?? '').trim().replace(/（[^）]*）|\([^)]*\)/g, '').trim()
  return s
}

// 产品名归一：存量 24 种写法 → 规范名（全半角括号/年份缩写/简称）；未命中保留 trim 原值
const PRODUCT_MAP = {
  '365连麦': '365连麦', '365 连麦': '365连麦', '365': '365连麦',
  '2026女商私董': '2026女商私董', '26女商私董': '2026女商私董',
  '商业下午茶（旁听）': '商业下午茶·旁听', '商业下午茶旁听': '商业下午茶·旁听', '下午茶旁听': '商业下午茶·旁听',
  '商业下午茶上桌': '商业下午茶·上桌', '下午茶上桌': '商业下午茶·上桌', '商业下午茶（上桌）': '商业下午茶·上桌', '商业下午茶': '商业下午茶·上桌',
  '1v1咨询': '1V1商业咨询', '1v1商业咨询': '1V1商业咨询', '1V1咨询': '1V1商业咨询',
  '刘润年度演讲单日': '刘润年度演讲·单日', '刘润年度演讲套票': '刘润年度演讲·套票',
}
export function normalizeProduct(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return ''
  if (PRODUCT_MAP[s]) return PRODUCT_MAP[s]
  // 「365连麦(微店)」→ 括号前主体归一（渠道后缀保留区分度时先归主体）
  const m = s.match(/^(.+?)[（(]([^）)]*)[）)]$/)
  if (m) {
    const base = PRODUCT_MAP[m[1].trim()]
    if (base) return base
  }
  return s
}

// 付款平台归一到五枚举（微信/支付宝/微店/线下/其他）；未识别返回 ''（不猜，S79-1）
const PAY_PLATFORM_MAP = {
  微信: '微信', wechat: '微信', 微信支付: '微信',
  支付宝: '支付宝', alipay: '支付宝', 蔫蔫支付宝: '支付宝',
  微店: '微店', weidian: '微店',
  线下: '线下', 对公转账: '线下', 公对公转账: '线下', 对公: '线下', 银行转账: '线下', 转账: '线下',
  其他: '其他', 微博: '其他', 链接: '其他', 快手: '其他', 抖音: '其他',
}
export function normalizePayPlatform(raw) {
  const s = String(raw ?? '').trim()
  return PAY_PLATFORM_MAP[s] || ''
}

// 是/否布尔归一（是|属于自营|yes|y|true → 是；否|no|n|false → 否；其余 ''）
export function normalizeYesNo(raw) {
  const s = String(raw ?? '').trim().toLowerCase()
  if (['是', 'yes', 'y', 'true', '1', '属于自营'].includes(s)) return '是'
  if (['否', 'no', 'n', 'false', '0', '不属于'].includes(s)) return '否'
  return ''
}

// 金额归一（元）：¥3,500 / 3500元 / 3.5万 / 0.35万 / ¥12,800.00 → number；无法解析返回 null（不猜）
export function parseAmount(raw) {
  const s = String(raw ?? '').replace(/[¥￥,，\s元]/gi, '').trim()
  if (!s) return null
  const m = s.match(/^(\d+(?:\.\d+)?)(万|w|W)?$/)
  if (!m) return null
  const n = Number(m[1])
  if (!Number.isFinite(n) || n < 0) return null
  return m[2] ? Math.round(n * 10000 * 100) / 100 : Math.round(n * 100) / 100
}

// 成交日期归一 → 北京日历日（S19）。v0.95.4「大幅度容忍」（用户拍板）：
// 全角数字/全角标点自动折半角；年/月/日/号 与 - / . 空格任意混用作分隔（2026年11.19、11月19号、
// 2026 11 19 全认）；相对词 今天/昨天/前天。月日缺年缺省当年（早于半年前归明年）。
// 解析出仍非真实日历日（13 月/32 日）返回 null（不猜）；无法解析返回 null（缺日期走 pending）。
const pad2 = (x) => String(x).padStart(2, '0')
export function parseDealDate(raw, { today: todayStr = today() } = {}) {
  const s = String(raw ?? '').trim()
  if (!s) return null
  if (s === '今天' || s === '今日' || s === '当天') return todayStr
  if (s === '昨天') return addDays(todayStr, -1)
  if (s === '前天') return addDays(todayStr, -2)
<<<<<<< HEAD
  let m = s.match(/^(\d{4})年(\d{1,2})月(\d{1,2})\s*日?$/) // 「19 日」数字与日之间空格（输入法常见，线上实证 v0.95.1）
  let day = null
  if (m) day = `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`
  else if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/))) day = `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`
  else if ((m = s.match(/^(\d{1,2})[-/.月](\d{1,2})日?$/))) { // 点分隔「11.19」（线上实证 v0.95.3）
    let y = Number(todayStr.slice(0, 4))
    const md = `${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`
    if (dayDiff(todayStr, `${y}-${md}`) < -180) y += 1 // 已过半年前的月日 = 下一周期（明年）
    day = `${y}-${md}`
=======
  const t = s
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)) // 全角数字 → 半角
    .replace(/[．・。]/g, '.').replace(/[－—–～]/g, '-').replace(/[／]/g, '/')
    .replace(/[，、,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  let m = t.match(/^(\d{4})\s*[年\-/. ]\s*(\d{1,2})\s*[月\-/. ]\s*(\d{1,2})\s*[日号]?$/)
  if (m) {
    const day = `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`
    return isCalendarDay(day) ? day : null
>>>>>>> origin/feat/date-lenient
  }
  if ((m = t.match(/^(\d{1,2})\s*[月\-/. ]\s*(\d{1,2})\s*[日号]?$/))) {
    let y = Number(todayStr.slice(0, 4))
    const md = `${pad2(m[1])}-${pad2(m[2])}`
    if (dayDiff(todayStr, `${y}-${md}`) < -180) y += 1 // 已过半年前的月日 = 下一周期（明年）
    const day = `${y}-${md}`
    return isCalendarDay(day) ? day : null
  }
  return null
}

// —— 模板解析 ——

// 字段别名表：模板字段名 + 常见简写（越长越优先匹配，防「客户昵称」被「客户」截胡）
const FIELD_ALIASES = {
  dealDate: ['成交日期', '日期'],
  amount: ['成交金额', '金额'],
  product: ['成交产品', '购买产品', '产品'],
  assistant: ['成交小助手', '小助手'],
  customerNick: ['客户昵称/标识', '客户昵称', '客户标识'],
  orderNo: ['订单编号', '订单号'],
  payPlatform: ['付款平台', '支付平台'],
  tradeNo: ['付款账号或交易号', '付款交易号', '交易号', '付款账号'],
  voucher: ['成交凭证'],
  selfOwned: ['是否属于自营产品', '是否自营产品', '是否自营'],
  distribution: ['是否涉及分销', '是否分销'],
  note: ['备注'],
  customerName: ['客户姓名'],
  customerPhone: ['客户手机号', '客户电话', '手机号'],
}
// 别名展平并按长度降序（长名优先），形如 [/^(别名)[:：]/, key]
const LINE_MATCHERS = Object.entries(FIELD_ALIASES)
  .flatMap(([key, aliases]) => aliases.map((a) => [a, key]))
  .sort((a, b) => b[0].length - a[0].length)
  .map(([alias, key]) => [new RegExp(`^\\s*${alias}\\s*[:：]\\s*(.*)$`), key, alias])

// 报单强信号关键词（S79-3）：驱动 LLM 兜底——收窄到「报单/出单/开单/签单/成交了」类动作词，
// 裸「成交」不进（「这个月冲 30 万成交目标」是目标讨论不是报单，防闲聊烧 LLM）。
const REPORT_HINTS = /报单|出单|开单|签单|成交了|成交一单|成交 1|成交1/
export function looksLikeReport(text) {
  const s = String(text ?? '')
  if (!s.trim()) return false
  if (REPORT_HINTS.test(s)) return true
  return countFieldLines(s) >= 1
}

function countFieldLines(text) {
  let n = 0
  for (const line of String(text ?? '').split(/\n/)) {
    for (const [re] of LINE_MATCHERS) {
      if (re.test(line)) { n++; break }
    }
  }
  return n
}

/**
 * 解析一条模板报单（确定性，无 LLM）。
 * 返回 { matched, fields, missing, fieldLineCount }：
 * - matched：**模板结构命中**（≥2 个「字段名：值」行被识别）——确定性层只认结构不猜关键词
 *   （关键词命中的口语化消息由 brain/salesExtract.js 走 LLM 兜底，判定权交给模型）
 * - fields：归一后的字段（camelCase；dealDay 北京日、amount 元、枚举已归一）
 * - missing：关键字段（orderNo/amount/dealDay）缺失清单——非空则不落账（S79-4）
 * - fieldLineCount：识别出的字段行数
 */
export function parseReport(text, opts = {}) {
  const raw = {}
  for (const line of String(text ?? '').split(/\n/)) {
    for (const [re, key] of LINE_MATCHERS) {
      const m = line.match(re)
      if (m) { raw[key] = m[1].trim(); break } // 一行只归第一个（最长别名）字段
    }
  }
  const fieldLineCount = Object.keys(raw).length
  const matched = fieldLineCount >= 2
  if (!matched) return { matched: false, fields: null, missing: [], fieldLineCount }

  const dealDay = raw.dealDate !== undefined ? parseDealDate(raw.dealDate, opts) : null
  const fields = {
    dealDay,
    amount: raw.amount !== undefined ? parseAmount(raw.amount) : null,
    orderNo: String(raw.orderNo ?? '').trim(),
    product: normalizeProduct(raw.product),
    assistant: normalizeAssistant(raw.assistant),
    customerNick: String(raw.customerNick ?? '').trim(),
    customerName: String(raw.customerName ?? '').trim(),
    customerPhone: String(raw.customerPhone ?? '').trim().replace(/\s+/g, ''),
    payPlatform: normalizePayPlatform(raw.payPlatform),
    tradeNo: String(raw.tradeNo ?? '').trim(),
    voucher: String(raw.voucher ?? '').trim(),
    selfOwned: normalizeYesNo(raw.selfOwned),
    distribution: normalizeYesNo(raw.distribution),
    note: String(raw.note ?? '').trim().replace(/^[_＿\s]+$/, ''), // 模板占位符「____」归一为空
  }
  // v0.95.3（K81 边界修订）：订单号降级可选——外部渠道成交（线下/外部链接）天然无单号
  // （线上实证：刘润链接单被拦 pending）。防重改由组合查重兜底（客户+日+金额，对所有记录生效）。
  const missing = []
  if (fields.amount == null) missing.push('成交金额')
  if (!fields.dealDay) missing.push('成交日期')
  return { matched: true, fields, missing, fieldLineCount }
}
