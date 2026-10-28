// 时间与时区唯一真相源（PRD S19，v0.10）：日历日一律北京时区（Asia/Shanghai，UTC+8，无夏令时）。
// 时间戳存储为 epoch 毫秒（时区无关）；所有「今天/当日零点/本周一」的解释必须经由本文件，
// SQL 侧经 db 连接层注册的 BJ_TODAY()（同源）。禁止散写 new Date().toISOString().slice(0,10)（UTC 语义）。

export const TZ = 'Asia/Shanghai'
export const DAY_MS = 86_400_000
const OFFSET = 8 * 3_600_000 // 固定 +8（无夏令时，恒成立且不依赖 tzdata/ICU）

/**
 * 北京日历日（YYYY-MM-DD）。接受 Date、epoch 毫秒或留空取当前时刻；
 * 固定时刻断言请显式传参（如 today(Date.UTC(2026,8,30,17)) === '2026-10-01'）。
 */
export function today(at = new Date()) {
  const d = at == null ? new Date() : new Date(at)
  return new Date(d.getTime() + OFFSET).toISOString().slice(0, 10)
}

/** 时刻所在北京日的零点（epoch 毫秒，与服务器时区无关）。 */
export function bjDayStartMs(at = new Date()) {
  const t = (at == null ? new Date() : new Date(at)).getTime()
  return Math.floor((t + OFFSET) / DAY_MS) * DAY_MS - OFFSET
}

/** 时刻所在北京自然周的周一零点（epoch 毫秒）。 */
export function bjWeekStartMs(at = new Date()) {
  const start = bjDayStartMs(at)
  const weekday = new Date(start + OFFSET).getUTCDay() // 北京零点的 UTC 瞬间，getUTCDay 即北京星期
  return start - ((weekday + 6) % 7) * DAY_MS
}

/** 两个北京日历日相差的天数（toDay - fromDay；跨年/跨月正确，纯日期串无时区语义）。 */
export function dayDiff(fromDay, toDay) {
  return Math.round((Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`)) / DAY_MS)
}

/** 北京时刻戳串（YYYYMMDD-HHMMSS，零填充字典序=时间序；备份对象命名用，S34）。 */
export function bjStamp(at = new Date()) {
  const iso = new Date((at == null ? new Date() : new Date(at)).getTime() + OFFSET).toISOString()
  return `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}`
}

/** 北京日历日加 N 天（N 可为负/零；与 dayDiff 同一 UTC 午夜基准，纯日期串运算）。 */
export function addDays(day, n) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10)
}

/** 北京日历日的星期（1=周一…7=周日；S69 周视图/适用星期口径，纯日期串无时区语义）。 */
export function weekdayOf(day) {
  const utc = new Date(Date.parse(`${day}T00:00:00Z`)).getUTCDay() // 0=周日…6=周六
  return utc === 0 ? 7 : utc
}

/** day 所在北京自然周的周一（S69：weeklyBoard 以任意日定位所在周）。 */
export function mondayOf(day) {
  return addDays(day, -(weekdayOf(day) - 1))
}

/** day 所在自然月的第一天（YYYY-MM-01；S69-8 月窗口，纯日期串算术）。 */
export function monthStartOf(day) {
  return `${day.slice(0, 7)}-01`
}

/** day 所在自然月的下月第一天（跨年正确；月窗口右界与月导航用）。 */
export function nextMonthStartOf(day) {
  const [y, m] = day.split('-').map(Number)
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`
}

/** 自然月整月平移 n 个月（入参为月内任意日，返回目标月 1 号；y·12+m 整数化，跨年正确）。 */
export function monthShiftOf(day, n) {
  const [y, m] = day.split('-').map(Number)
  const t = y * 12 + (m - 1) + n
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}-01`
}

const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/

/** YYYY-MM-DD 真实日历日校验（纯算术比对，拒绝 2026-13-40 这类滚动越界；无时区语义）。
 *  v0.80（S69）自 engine/tasks.js 移入：日期纯函数归位时间层，dailyBoard 无环引用 tasks。 */
export function isCalendarDay(s) {
  if (typeof s !== 'string' || !DATE_SHAPE.test(s)) return false
  const [y, m, d] = s.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}
