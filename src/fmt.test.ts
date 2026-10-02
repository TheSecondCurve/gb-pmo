import { describe, it, expect } from 'vitest'
import { fmtDate, fmtDateTime, bjToday, dateRangeForm, fmtDateRange } from './fmt'

// PRD S19-4：epoch 时间戳展示显式按 Asia/Shanghai，不随浏览器/测试机时区漂移。
// 2026-09-30T17:00:00Z = 北京 2026-10-01 01:00
const AFTER_BJ_MIDNIGHT = Date.UTC(2026, 8, 30, 17)

describe('S19 前端时间格式化（北京时区）', () => {
  it('S19-4: fmtDateTime 按北京时区取日历日与时刻', () => {
    expect(fmtDateTime(AFTER_BJ_MIDNIGHT)).toContain('2026')
    expect(fmtDateTime(AFTER_BJ_MIDNIGHT)).toMatch(/10[/-]01/)
    expect(fmtDateTime(AFTER_BJ_MIDNIGHT)).toMatch(/01:00/)
  })

  it('S19-4: fmtDate 按北京时区取日历日（跨 UTC 日不回退一天）', () => {
    expect(fmtDate(AFTER_BJ_MIDNIGHT)).toMatch(/2026/)
    expect(fmtDate(AFTER_BJ_MIDNIGHT)).toMatch(/10[/-]01/)
    expect(fmtDate(Date.UTC(2026, 8, 30, 2))).toMatch(/09[/-]30/)
  })
})

// PRD S30-4（v0.29）— 日期文案四式：松散排期语言（日期全可空合法，不虚构日期）。
describe('S30 日期文案四式（松散排期语言）', () => {
  it('S30-4: fmtDateRange 输出四式文案', () => {
    expect(fmtDateRange('2026-03-01', '2026-04-15')).toBe('2026-03-01 ~ 2026-04-15')
    expect(fmtDateRange(null, '2026-04-15')).toBe('交付 2026-04-15')
    expect(fmtDateRange('2026-03-01', null)).toBe('2026-03-01 起')
    expect(fmtDateRange(null, null)).toBe('未排期')
    expect(fmtDateRange(undefined, undefined)).toBe('未排期')
  })

  it('S30-4: dateRangeForm 判形与文案一致', () => {
    expect(dateRangeForm('2026-03-01', '2026-04-15')).toBe('range')
    expect(dateRangeForm(null, '2026-04-15')).toBe('deadline')
    expect(dateRangeForm('2026-03-01', null)).toBe('open')
    expect(dateRangeForm(null, null)).toBe('none')
  })

  it('S30-4: bjToday 为北京日历日 YYYY-MM-DD（与后端 BJ_TODAY 同口径）', () => {
    expect(bjToday()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})
