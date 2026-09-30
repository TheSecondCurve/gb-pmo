import { describe, it, expect } from 'vitest'
import { fmtDate, fmtDateTime } from './fmt'

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
