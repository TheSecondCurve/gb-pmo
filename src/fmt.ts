// 时间展示统一时区（PRD S19）：epoch 时间戳显式按北京时区格式化，不随浏览器时区漂移。
// 纯日期文本（YYYY-MM-DD）直接展示，禁止 new Date('YYYY-MM-DD') 反解（UTC 午夜语义会在非东八区浏览器错一天）。
const BJ = 'Asia/Shanghai'

const dateTimeFmt = new Intl.DateTimeFormat('zh-CN', {
  timeZone: BJ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
})
const dateFmt = new Intl.DateTimeFormat('zh-CN', { timeZone: BJ, year: 'numeric', month: '2-digit', day: '2-digit' })

export const fmtDateTime = (ms: number) => dateTimeFmt.format(new Date(ms))
export const fmtDate = (ms: number) => dateFmt.format(new Date(ms))
