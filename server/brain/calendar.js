// 飞书项目日历（S22，v0.12）：组织级日历 + 对账式同步。
// 设计（PRD §7.6）：纯出站推送（内网可用）；每轮全量计算期望事件内容，与 calendar_sync
// 映射表按内容 hash 比对——无行 create、hash 变 patch、未变零 API 调用；结项/取消项目
// 事件保留不删（标题加终态前缀、日期定格实际周期）；单项目失败不阻塞其余。
// 日历日语义走 db/time.js（S19 北京时区）；全日事件起止=首日/末日（闭区间）。

import { createHash } from 'node:crypto'
import { getSetting, setSetting } from '../engine/settings.js'
import { label } from '../engine/enums.js'
import * as feishu from './connectors/feishu.js'

const TERMINAL_PREFIX = { closed: '【已结项】', cancelled: '【已取消】' }

/**
 * 期望事件内容（纯函数）：全日、闭区间。
 * 起 = 实际启动日 ‖ 计划开始日（缺失时锚到止日）；止 = 交付日期（终态=实际结束日 ‖ 交付日期）。
 * 无任何日期 → null（调用方跳过计数）。
 */
export function eventContent(p) {
  const terminal = p.status === 'closed' || p.status === 'cancelled'
  const startDay = p.actual_start_date || p.plan_start_date
  const endDay = terminal ? (p.actual_end_date || p.plan_end_date) : p.plan_end_date
  if (!startDay && !endDay) return null
  const summary = `${TERMINAL_PREFIX[p.status] || ''}${p.name}`
  const description = `状态：${label('projectStatus', p.status)} · 牵头人：${p.lead_name || `#${p.lead_member_id}`}` +
    ` · 优先级：${label('priority', p.priority)}${p.client_name ? ` · 客户：${p.client_name}` : ''}` +
    `${terminal ? ` · 周期已定格（${p.actual_start_date || p.plan_start_date || '?'} ~ ${endDay}）` : ''}`
  return { summary, description, startDay: startDay || endDay, endDay: endDay || startDay }
}

const contentHash = (content) =>
  createHash('sha1').update(`${content.summary}|${content.description}|${content.startDay}|${content.endDay}`).digest('hex')

/** 初始化项目日历：应用身份创建组织内可订阅日历，calendar_id 落 settings `calendar` 块。 */
export async function initProjectCalendar(db, by) {
  const cfg = getSetting(db, 'im.feishu')
  if (!cfg.appId || !cfg.appSecret) {
    throw Object.assign(new Error('未配置 appId/appSecret（先在外部依赖→飞书保存应用凭证，申请流程见 PRD 附录 A.1）'), { statusCode: 400 })
  }
  const { calendarId } = await feishu.createCalendar(cfg, {
    summary: '项目日历（gb-pmo）',
    description: '全部项目起止日期 · 项目大脑自动维护（结项项目保留）· 订阅即见',
  })
  if (!calendarId) throw Object.assign(new Error('飞书未返回 calendar_id'), { statusCode: 502 })
  setSetting(db, 'calendar', { feishuCalendarId: calendarId }, by)
  return { calendarId }
}

/**
 * 对账式同步：返回 { calendarId, created, updated, skipped, errors }；
 * 未初始化日历（无 calendar_id）时返回 { skipped: true, reason }，不发起任何飞书调用。
 */
export async function syncProjectCalendar(db, { connector = feishu } = {}) {
  const { feishuCalendarId } = getSetting(db, 'calendar')
  if (!feishuCalendarId) {
    return { skipped: true, reason: '未初始化项目日历（配置台「外部依赖→飞书」→ 初始化项目日历，S22）' }
  }
  const cfg = getSetting(db, 'im.feishu')
  const projects = db
    .prepare(
      `SELECT p.*, m.name AS lead_name FROM projects p LEFT JOIN members m ON m.id = p.lead_member_id ORDER BY p.id`
    )
    .all()
  const mappings = new Map(
    db.prepare('SELECT * FROM calendar_sync').all().map((r) => [r.project_id, r])
  )
  const out = { calendarId: feishuCalendarId, created: 0, updated: 0, skipped: 0, errors: [] }

  for (const p of projects) {
    const content = eventContent(p)
    if (!content) {
      out.skipped += 1
      continue
    }
    const hash = contentHash(content)
    const m = mappings.get(p.id)
    if (m && m.content_hash === hash) {
      if (m.last_error) db.prepare('UPDATE calendar_sync SET last_error = NULL WHERE project_id = ?').run(p.id)
      continue
    }
    try {
      if (!m) {
        const { eventId } = await connector.createEvent(cfg, feishuCalendarId, content)
        if (!eventId) throw new Error('飞书未返回 event_id')
        db.prepare(
          'INSERT INTO calendar_sync (project_id, calendar_event_id, content_hash, synced_at) VALUES (?, ?, ?, ?)'
        ).run(p.id, eventId, hash, Date.now())
        out.created += 1
      } else {
        await connector.patchEvent(cfg, feishuCalendarId, m.calendar_event_id, content)
        db.prepare(
          'UPDATE calendar_sync SET content_hash = ?, synced_at = ?, last_error = NULL WHERE project_id = ?'
        ).run(hash, Date.now(), p.id)
        out.updated += 1
      }
    } catch (e) {
      // create 失败无映射行（下轮整体重试）；patch 失败记 last_error，hash 不推进
      if (m) db.prepare('UPDATE calendar_sync SET last_error = ? WHERE project_id = ?').run(e.message, p.id)
      out.errors.push({ projectId: p.id, name: p.name, error: e.message })
    }
  }
  return out
}
