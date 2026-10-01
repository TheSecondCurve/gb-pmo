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

/** 北京日历日加 N 天（N 可为负/零；与 dayDiff 同一 UTC 午夜基准，纯日期串运算）。 */
export function addDays(day, n) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10)
}
