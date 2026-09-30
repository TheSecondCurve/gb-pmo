// cron 表达式引擎（S18，v0.7）：标准 5 字段（分 时 日 月 周），纯函数无依赖。
// 语法子集：每字段支持 *、*/n、a、a-b、a-b/n，逗号列表组合；周 0-7（0/7 均为周日）。
// 语义说明：dom 与 dow 同时受限时按 AND 匹配（不实现 Vixie cron 的 OR 特例，调度配置场景用不到）。

const FIELDS = [
  { name: '分', min: 0, max: 59 },
  { name: '时', min: 0, max: 23 },
  { name: '日', min: 1, max: 31 },
  { name: '月', min: 1, max: 12 },
  { name: '周', min: 0, max: 7 },
]

function fail(field, detail) {
  throw Object.assign(new Error(`cron 字段「${field}」不合法：${detail}`), { statusCode: 400 })
}

function parseTerm(term, field) {
  if (term === '*') {
    const out = []
    for (let v = field.min; v <= field.max; v++) out.push(field.name === '周' && v === 7 ? 0 : v)
    return out
  }
  const stepMatch = term.match(/^(\*|\d+-\d+)\/(\d+)$/)
  if (stepMatch) {
    const step = Number(stepMatch[2])
    if (!step || step < 1) fail(field.name, `步进 ${stepMatch[2]} 必须 ≥1`)
    let lo = field.min
    let hi = field.max
    if (stepMatch[1] !== '*') {
      const [a, b] = stepMatch[1].split('-').map(Number)
      ;[lo, hi] = [a, b]
    }
    if (lo < field.min || hi > field.max || lo > hi) fail(field.name, `范围 ${lo}-${hi} 越界（${field.min}-${field.max}）`)
    const out = []
    for (let v = lo; v <= hi; v += step) out.push(field.name === '周' && v === 7 ? 0 : v)
    return out
  }
  const rangeMatch = term.match(/^(\d+)-(\d+)$/)
  if (rangeMatch) {
    const [a, b] = [Number(rangeMatch[1]), Number(rangeMatch[2])]
    if (a < field.min || b > field.max || a > b) fail(field.name, `范围 ${a}-${b} 越界（${field.min}-${field.max}）`)
    const out = []
    for (let v = a; v <= b; v++) out.push(field.name === '周' && v === 7 ? 0 : v)
    return out
  }
  if (/^\d+$/.test(term)) {
    const v = Number(term)
    if (v < field.min || v > field.max) fail(field.name, `值 ${v} 越界（${field.min}-${field.max}）`)
    return [field.name === '周' && v === 7 ? 0 : v]
  }
  fail(field.name, `无法解析「${term}」`)
}

export function parseCron(expr) {
  const parts = String(expr ?? '').trim().split(/\s+/)
  if (parts.length !== 5) {
    throw Object.assign(new Error(`cron 必须为 5 个字段（分 时 日 月 周），当前 ${parts.length} 个`), { statusCode: 400 })
  }
  const parsed = {}
  FIELDS.forEach((field, i) => {
    const values = new Set()
    for (const term of parts[i].split(',')) {
      if (!term) fail(field.name, '逗号列表含空项')
      parseTerm(term, field).forEach((v) => values.add(v))
    }
    parsed[field.name] = values
  })
  return parsed
}

/** 该 Date 所在分钟是否命中（本地时区）。 */
export function matchesMinute(parsed, date) {
  return (
    parsed['分'].has(date.getMinutes()) &&
    parsed['时'].has(date.getHours()) &&
    parsed['日'].has(date.getDate()) &&
    parsed['月'].has(date.getMonth() + 1) &&
    parsed['周'].has(date.getDay())
  )
}

/** (lastRunMs, nowMs] 窗口内存在匹配分钟 → true。窗口上限 366 天，超限从上限处起算。 */
export function isDue(expr, lastRunMs, nowMs) {
  const parsed = parseCron(expr)
  if (nowMs <= lastRunMs) return false
  const MIN = 60_000
  const MAX_WINDOW = 366 * 24 * 60 * MIN
  let start = lastRunMs + 1
  if (nowMs - start > MAX_WINDOW) start = nowMs - MAX_WINDOW
  let m = Math.ceil(start / MIN) * MIN
  const end = Math.floor(nowMs / MIN) * MIN
  for (; m <= end; m += MIN) {
    if (matchesMinute(parsed, new Date(m))) return true
  }
  return false
}
