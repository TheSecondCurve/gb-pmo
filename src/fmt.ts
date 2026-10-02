// 时间展示统一时区（PRD S19）：epoch 时间戳显式按北京时区格式化，不随浏览器时区漂移。
// 纯日期文本（YYYY-MM-DD）直接展示，禁止 new Date('YYYY-MM-DD') 反解（UTC 午夜语义会在非东八区浏览器错一天）。
const BJ = 'Asia/Shanghai'

const dateTimeFmt = new Intl.DateTimeFormat('zh-CN', {
  timeZone: BJ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
})
const dateFmt = new Intl.DateTimeFormat('zh-CN', { timeZone: BJ, year: 'numeric', month: '2-digit', day: '2-digit' })

export const fmtDateTime = (ms: number) => dateTimeFmt.format(new Date(ms))
export const fmtDate = (ms: number) => dateFmt.format(new Date(ms))

// 北京日历日的今天（YYYY-MM-DD），与后端 BJ_TODAY()/today() 同口径（S19/S30）。
// en-CA locale 恰好输出 YYYY-MM-DD；显式时区不随浏览器漂移。
const bjDayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: BJ, year: 'numeric', month: '2-digit', day: '2-digit' })
export const bjToday = (): string => bjDayFmt.format(new Date())

// S30-4 松散排期语言：日期全可空合法，展示不虚构——四式文案 + 判形。
export type DateRangeForm = 'range' | 'deadline' | 'open' | 'none'
export function dateRangeForm(start?: string | null, end?: string | null): DateRangeForm {
  if (start && end) return 'range'
  if (end) return 'deadline'
  if (start) return 'open'
  return 'none'
}
export function fmtDateRange(start?: string | null, end?: string | null): string {
  const form = dateRangeForm(start, end)
  if (form === 'range') return `${start} ~ ${end}`
  if (form === 'deadline') return `交付 ${end}`
  if (form === 'open') return `${start} 起`
  return '未排期'
}
