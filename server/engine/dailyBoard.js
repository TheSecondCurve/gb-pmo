// S69（v0.80，design.md K64）：常态项目执行视图 + 每日打卡引擎。
// v0.81（K65，S69-8）：窗口三档 span（周/双周/月）——窗口数学唯一真相源在引擎（BOARD_SPANS 表驱动），
// 前端导航只消费响应里的 prevAnchor/nextAnchor，不做任何日期推算；行统计为「本期」口径。
// 建模：任务行=模板（tasks.kind='routine' + weekdays 适用星期），每日执行状态独立落
// task_day_records（(task_id, day) 唯一，惰性 upsert——不预生成实例，无记录=未做；重置=删行）。
// 打卡=记录型事件（K50 语义）：每次状态变更同步落讨论面 record 型 progress 事件（append-only）+ 审计。
// 打卡按天不按期：三档窗口下「可补过去、拒未来」与适用星期语义均不变（周档=北京自然周周一锚点，S19）。

import { today, addDays, weekdayOf, mondayOf, isCalendarDay, dayDiff, monthStartOf, nextMonthStartOf, monthShiftOf } from '../db/time.js'
import { assertValue, label } from './enums.js'
import { addEvent } from './events.js'
import { audit } from './auth.js'
import { normalizeTaskNote, normalizeWeekdays } from './projectTypes.js'

const WEEKDAY_CHARS = ['', '一', '二', '三', '四', '五', '六', '日']
export const ALL_WEEK = [1, 2, 3, 4, 5, 6, 7]

/**
 * 双周全局纪元锚（K65）：2024-01-01 恰为周一，自它起每 14 天一期——连续、确定、跨年不断链。
 * （按年锚「当年第一个周一」各年首周一间隔非 14 倍数，跨年处会断出残期，弃用。）
 */
export const BIWEEK_EPOCH = '2024-01-01'

const biweekStartOf = (day) => addDays(BIWEEK_EPOCH, Math.floor(dayDiff(BIWEEK_EPOCH, day) / 14) * 14)

const rangeOf = (start, n) => Array.from({ length: n }, (_, i) => addDays(start, i))
const rangeUntil = (start, exclusiveEnd) => {
  const days = []
  for (let d = start; d < exclusiveEnd; d = addDays(d, 1)) days.push(d)
  return days
}

/**
 * 执行视图窗口目录（K65：加档=加一行配置，无 if/else 散落）。每档两件事：
 * window(anchor) → 期内逐日 days[]；shift(start, ±n) → 相邻期锚点（导航服务端下发）。
 */
export const BOARD_SPANS = {
  week: {
    label: '周',
    window: (anchor) => rangeOf(mondayOf(anchor), 7),
    shift: (start, n) => addDays(start, n * 7),
  },
  biweek: {
    label: '双周',
    window: (anchor) => rangeOf(biweekStartOf(anchor), 14),
    shift: (start, n) => addDays(start, n * 14),
  },
  month: {
    label: '月',
    window: (anchor) => rangeUntil(monthStartOf(anchor), nextMonthStartOf(anchor)),
    shift: (start, n) => monthShiftOf(start, n),
  },
}

/** 适用星期的中文标签：全周=「每天」，否则「每周一、三、五」。 */
export function weekdaysLabel(weekdays) {
  const days = Array.isArray(weekdays) && weekdays.length ? weekdays : ALL_WEEK
  if (days.length === 7) return '每天'
  return `每周${days.map((d) => WEEKDAY_CHARS[d] || d).join('、')}`
}

/** CSV '1,3,5' → [1,3,5]（库内形态 → JSON 形态；空/NULL → null，非常态任务无适用星期概念）。
 *  tasks.js 装饰任务行共用（单一真相源；dailyBoard 不反向依赖 tasks，无环）。 */
export function parseWeekdays(csv) {
  if (!csv) return null
  return String(csv).split(',').map(Number).filter((d) => Number.isInteger(d) && d >= 1 && d <= 7)
}

function assertRoutineProject(db, projectId) {
  const project = db.prepare('SELECT id, name, kind, status, board_span FROM projects WHERE id = ?').get(Number(projectId))
  if (!project) throw Object.assign(new Error('项目不存在'), { statusCode: 404 })
  if (project.kind !== 'routine') {
    throw Object.assign(new Error('执行视图仅常态项目可用（该项目是交付项目，S69）'), { statusCode: 400 })
  }
  return project
}

/**
 * S69-2/S69-8 执行视图取数：行=常态任务（编号/标题/备注/责任人/适用星期），列=窗口内逐日格子。
 * span ∈ week|biweek|month（解析序 = 参数 → 项目默认 board_span → week，中央枚举校验非法 400）；
 * anchor=任意北京日历日（定位所在期，缺省今天）；响应含 start/end/days/prevAnchor/nextAnchor——
 * 窗口数学唯一在引擎，前端导航零日期推算。格子含 状态（pending=无记录）/备注/操作人/来源，
 * 不适用日 applicable=false；行尾 periodDone/periodApplicable（本期口径）、表尾 summary（逐日 perDay）。
 * 终态项目可读（历史可查）。
 */
export function getDailyBoard(db, projectId, { anchor, span, now = Date.now() } = {}) {
  const project = assertRoutineProject(db, projectId)
  const resolvedSpan = assertValue('boardSpan', span || project.board_span || 'week')
  let anchorDay
  if (anchor === undefined || anchor === null || anchor === '') {
    anchorDay = today(now)
  } else {
    if (!isCalendarDay(String(anchor))) {
      throw Object.assign(new Error('anchor 须为真实日历日 YYYY-MM-DD（任意一天，定位所在期）'), { statusCode: 400 })
    }
    anchorDay = String(anchor)
  }
  const days = BOARD_SPANS[resolvedSpan].window(anchorDay)
  const start = days[0]
  const end = days[days.length - 1]

  const tasks = db.prepare(
    `SELECT t.id AS task_id, t.title, t.note, t.weekdays, t.responsible_member_id, m.name AS responsible_name
     FROM tasks t LEFT JOIN members m ON m.id = t.responsible_member_id
     WHERE t.project_id = ? AND t.kind = 'routine' AND t.deleted_at IS NULL ORDER BY t.id`
  ).all(project.id)
  const ids = tasks.map((t) => t.task_id)
  const records = new Map()
  if (ids.length) {
    for (const r of db.prepare(
      `SELECT r.*, m.name AS operator_name FROM task_day_records r LEFT JOIN members m ON m.id = r.operator_member_id
       WHERE r.task_id IN (${ids.map(() => '?').join(',')}) AND r.day >= ? AND r.day <= ?`
    ).all(...ids, start, end)) {
      records.set(`${r.task_id}|${r.day}`, r)
    }
  }

  const rows = tasks.map((t) => {
    const weekdays = parseWeekdays(t.weekdays) ?? ALL_WEEK
    const applicable = new Set(weekdays)
    const cells = days.map((day) => {
      const r = records.get(`${t.task_id}|${day}`) || null
      return {
        day,
        applicable: applicable.has(weekdayOf(day)),
        status: r ? r.status : 'pending',
        note: r ? (r.note || null) : null,
        operatorMemberId: r ? r.operator_member_id : null,
        operatorName: r ? r.operator_name : null,
        source: r ? r.source : null,
        updatedAt: r ? r.updated_at : null,
      }
    })
    const periodApplicable = cells.filter((c) => c.applicable).length
    const periodDone = cells.filter((c) => c.applicable && c.status === 'done').length
    return {
      taskId: t.task_id, title: t.title, note: t.note ?? null,
      weekdays, weekdaysLabel: weekdaysLabel(weekdays),
      responsibleMemberId: t.responsible_member_id ?? null, responsibleName: t.responsible_name ?? null,
      cells, periodApplicable, periodDone,
    }
  })

  const perDay = days.map((day) => ({
    day,
    done: rows.reduce((s, r) => s + (r.cells.find((c) => c.day === day)?.status === 'done' ? 1 : 0), 0),
    skip: rows.reduce((s, r) => s + (r.cells.find((c) => c.day === day)?.status === 'skip' ? 1 : 0), 0),
  }))
  const applicableCells = rows.reduce((s, r) => s + r.periodApplicable, 0)
  const summary = {
    tasks: rows.length,
    applicableCells,
    done: rows.reduce((s, r) => s + r.periodDone, 0),
    skip: rows.reduce((s, r) => s + r.cells.filter((c) => c.applicable && c.status === 'skip').length, 0),
    pending: applicableCells - rows.reduce((s, r) => s + r.cells.filter((c) => c.applicable && c.status !== 'pending').length, 0),
    perDay,
  }
  return {
    projectId: project.id, span: resolvedSpan, start, end, days,
    prevAnchor: BOARD_SPANS[resolvedSpan].shift(start, -1),
    nextAnchor: BOARD_SPANS[resolvedSpan].shift(start, 1),
    tasks: rows, summary,
  }
}

/**
 * S69-3 每日打卡：status done/skip 惰性 upsert、pending=重置（删行）；单事务落 记录行 + record 型
 * progress 事件 + 审计。可补过去日期、拒绝未来日期（北京日）；不适用星期 400；终态项目 409 只读。
 * origin：web（页面格子）| bot（机器人 checkin_task，事件归因 sourcePlatform/generatedBy 随通道）。
 */
export function setDayStatus(db, { projectId, taskId, day, status, note }, by, { origin = 'web', sourcePlatform } = {}) {
  const project = assertRoutineProject(db, projectId)
  if (project.status === 'closed' || project.status === 'cancelled') {
    throw Object.assign(new Error('项目已结项/取消，周视图只读（S29 终态不可逆）'), { statusCode: 409 })
  }
  const task = db.prepare(
    `SELECT t.id, t.title, t.kind, t.weekdays, t.project_id FROM tasks t WHERE t.id = ? AND t.deleted_at IS NULL`
  ).get(Number(taskId))
  if (!task || task.project_id !== project.id) {
    throw Object.assign(new Error('任务不存在或不属于该项目'), { statusCode: 400 })
  }
  if (task.kind !== 'routine') {
    throw Object.assign(new Error('打卡仅常态任务可用（该任务是工作任务，S69）'), { statusCode: 400 })
  }
  const dayStr = String(day || '')
  if (!isCalendarDay(dayStr)) {
    throw Object.assign(new Error('day 须为真实日历日 YYYY-MM-DD（北京日，S19）'), { statusCode: 400 })
  }
  if (dayStr > today()) {
    throw Object.assign(new Error('不能给未来日期打卡（可补过去日期）'), { statusCode: 400 })
  }
  const weekdays = parseWeekdays(task.weekdays) ?? ALL_WEEK
  if (!weekdays.includes(weekdayOf(dayStr))) {
    throw Object.assign(new Error(`该任务在 ${dayStr} 不适用（适用：${weekdaysLabel(weekdays)}）`), { statusCode: 400 })
  }
  const nextStatus = assertValue('dayStatus', String(status))
  const cleanNote = normalizeTaskNote(note) ?? null
  if (cleanNote && nextStatus === 'pending') {
    throw Object.assign(new Error('未做状态不带备注（备注随完成/跳过记录保留）'), { statusCode: 400 })
  }

  const now = Date.now()
  const tx = db.transaction(() => {
    const cur = db.prepare('SELECT * FROM task_day_records WHERE task_id = ? AND day = ?').get(task.id, dayStr)
    // 变更判定：pending 重置仅在已有记录行时算变更（幂等重置无行不产事件）；done/skip 按状态或备注变化判定
    const changed = nextStatus === 'pending'
      ? Boolean(cur)
      : (!cur || cur.status !== nextStatus || (cur.note || null) !== cleanNote)
    let rowExistsAfter = false
    if (nextStatus === 'pending') {
      if (cur) db.prepare('DELETE FROM task_day_records WHERE task_id = ? AND day = ?').run(task.id, dayStr)
    } else if (cur) {
      db.prepare(
        'UPDATE task_day_records SET status = ?, note = ?, operator_member_id = ?, source = ?, updated_at = ? WHERE task_id = ? AND day = ?'
      ).run(nextStatus, cleanNote || '', by ?? null, origin, now, task.id, dayStr)
      rowExistsAfter = true
    } else {
      db.prepare(
        'INSERT INTO task_day_records (task_id, day, status, note, operator_member_id, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(task.id, dayStr, nextStatus, cleanNote || '', by ?? null, origin, now, now)
      rowExistsAfter = true
    }
    let eventId = null
    if (changed) {
      // 状态/备注变更才留讨论面痕迹（幂等重置无行、重复设置同值不刷事件流）
      const evt = addEvent(db, {
        projectId: project.id, businessTime: now, nature: 'record', eventType: 'progress',
        summary: `🗓 任务「${task.title}」${dayStr} ${label('dayStatus', nextStatus)}${cleanNote ? `：${cleanNote}` : ''}`,
        sourcePlatform: origin === 'bot' ? (sourcePlatform || 'feishu') : 'web',
        speakerMemberId: by ?? null,
        generatedBy: origin === 'bot' ? 'agent' : 'web',
      })
      eventId = evt.id
      audit(db, {
        memberId: by, action: 'task.dayStatus', objectType: 'task', objectId: task.id,
        detail: { projectId: project.id, day: dayStr, status: nextStatus, from: cur?.status ?? null, origin },
      })
    }
    const after = rowExistsAfter ? db.prepare('SELECT * FROM task_day_records WHERE task_id = ? AND day = ?').get(task.id, dayStr) : null
    return { cell: shapeCell(db, dayStr, after), eventId }
  })
  const { cell, eventId } = tx()
  return { ...cell, eventId }
}

function shapeCell(db, day, row) {
  if (!row) {
    return { day, status: 'pending', note: null, operatorMemberId: null, operatorName: null, source: null, updatedAt: null }
  }
  const m = row.operator_member_id
    ? db.prepare('SELECT name FROM members WHERE id = ?').get(row.operator_member_id)
    : null
  return {
    day, status: row.status, note: row.note || null,
    operatorMemberId: row.operator_member_id ?? null, operatorName: m?.name ?? null,
    source: row.source, updatedAt: row.updated_at,
  }
}

/**
 * S69-4 机器人任务定位：id 精确 / 标题精确 / 子串包含（taskTitle 与 taskHint 同义）。
 * 唯一命中返回任务行；零命中/多义抛中文 Error（多义带候选清单，K50「唯一目标」纪律）。
 */
export function findRoutineTaskByHint(db, projectId, hint) {
  const text = String(hint || '').trim()
  if (!text) throw new Error('taskId 或 taskTitle 至少给一个（先 query 查常态任务清单）')
  const rows = db.prepare(
    `SELECT id, title, weekdays FROM tasks
     WHERE project_id = ? AND kind = 'routine' AND deleted_at IS NULL ORDER BY id`
  ).all(Number(projectId))
  if (!rows.length) throw new Error('该项目没有常态任务（周视图按天打卡只管理 kind=routine 任务）')
  const exact = rows.find((t) => t.title === text)
  if (exact) return exact
  const hits = rows.filter((t) => t.title.includes(text))
  if (hits.length === 1) return hits[0]
  if (!hits.length) throw new Error(`未找到常态任务「${text}」（先 query 查任务清单）`)
  throw new Error(`「${text}」命中 ${hits.length} 条任务：${hits.map((t) => `#${t.id} ${t.title}`).join('、')}——请用 taskId 或更精确的名称`)
}

export { normalizeWeekdays }
