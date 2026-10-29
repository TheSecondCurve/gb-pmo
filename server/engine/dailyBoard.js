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

// —— S75（v0.87，K72）：常态任务周期四档（tasks.cadence JSON）——
// daily=每日（缺省）/ weekly=每周星期组合（S69 语义原样）/ biweekly=每两周（星期组合+期别 parity，
// 复用 K65 双周纪元锚：periodIndex=floor(dayDiff(纪元锚, day)/14)，parity=periodIndex%2）/
// monthly=每月几号组合（当月无该日不适用，cron 语义，不顺延）。
// 适用判定唯一真相源 isApplicableDay——执行视图 applicable、打卡 400 拒绝、晨报今日/明日待办全走它。

/** 周期 JSON 文本 → 对象（NULL/坏 JSON → null；防御读取，写入侧归一在 normalizeCadence）。 */
export function parseCadence(text) {
  if (!text) return null
  try {
    const obj = JSON.parse(text)
    return obj && typeof obj === 'object' && typeof obj.type === 'string' ? obj : null
  } catch {
    return null
  }
}

/** legacy weekdays（数组/'1,3' CSV）→ cadence：全周/未给 → daily；子集 → weekly。
 *  bot add_task / 提议 / 立项模板路径的兼容映射（入参兼容，单一真相源仍是 cadence）。 */
export function weekdaysToCadence(value) {
  const days = normalizeWeekdays(value) // undefined → daily；空集/越界沿用 S69 的 400 文案
  if (!days || days.length === 7) return { type: 'daily' }
  return { type: 'weekly', weekdays: days }
}

/** cadence 载荷归一（S75-1）：undefined/null → undefined（未给，建任务缺省 daily 由调用方落）；
 *  四档参数校验非法抛 400；返回规范化对象（weekdays/monthDays 升序去重、parity 缺省 0）。 */
export function normalizeCadence(value) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw Object.assign(new Error('cadence 须为周期对象：{type:"daily"} / {type:"weekly",weekdays:[1,3,5]} / {type:"biweekly",weekdays:[1],parity:0|1} / {type:"monthly",monthDays:[1,15]}'), { statusCode: 400 })
  }
  const type = assertValue('cadenceType', value.type)
  if (type === 'daily') {
    if (value.weekdays != null || value.monthDays != null) {
      throw Object.assign(new Error('daily 档无参数（周期参数只随 weekly/biweekly/monthly）'), { statusCode: 400 })
    }
    return { type: 'daily' }
  }
  if (type === 'monthly') {
    if (!Array.isArray(value.monthDays) || !value.monthDays.length) {
      throw Object.assign(new Error('monthly 档须带 monthDays（1~31 的整数，至少 1 天）'), { statusCode: 400 })
    }
    const days = [...new Set(value.monthDays.map(Number))]
    if (days.some((d) => !Number.isInteger(d) || d < 1 || d > 31)) {
      throw Object.assign(new Error('monthDays 须为 1~31 的整数'), { statusCode: 400 })
    }
    return { type: 'monthly', monthDays: days.sort((a, b) => a - b) }
  }
  // weekly / biweekly 共用星期校验
  let weekdays
  try {
    weekdays = normalizeWeekdays(value.weekdays)
  } catch (e) {
    throw Object.assign(new Error(`周期 weekdays 非法：${e.message}`), { statusCode: 400 })
  }
  if (!weekdays) {
    throw Object.assign(new Error(`${type} 档须带 weekdays（1~7 的整数，至少 1 天）`), { statusCode: 400 })
  }
  if (type === 'weekly') return { type: 'weekly', weekdays }
  const parity = value.parity ?? 0
  if (parity !== 0 && parity !== 1) {
    throw Object.assign(new Error('biweekly 档 parity 须为 0 或 1（K65 纪元锚期别）'), { statusCode: 400 })
  }
  return { type: 'biweekly', weekdays, parity }
}

/** 周期中文标签：每天 / 每周一、三、五 / 每两周周一、三 / 每月1、15、31号。 */
export function cadenceLabel(cadence) {
  const c = cadence && cadence.type ? cadence : { type: 'daily' }
  if (c.type === 'daily') return '每天'
  if (c.type === 'weekly') return weekdaysLabel(c.weekdays)
  if (c.type === 'biweekly') return `每两周${(c.weekdays || []).map((d) => `周${WEEKDAY_CHARS[d] || d}`).join('、')}`
  return `每月${(c.monthDays || []).join('、')}号`
}

/** cadence → 派生 weekdays 出参（兼容既有消费方）：daily→[1..7]；weekly/biweekly→其星期集；monthly/无→null。 */
export function cadenceWeekdays(cadence) {
  if (!cadence) return null
  if (cadence.type === 'daily') return ALL_WEEK
  if (cadence.type === 'weekly' || cadence.type === 'biweekly') return cadence.weekdays ?? null
  return null
}

/** 某北京日历日是否适用（S75 唯一真相源）：monthly 取日号（当月无该日自然不适用）；biweekly 星期命中且期别匹配。 */
export function isApplicableDay(cadence, day) {
  const c = cadence && cadence.type ? cadence : { type: 'daily' }
  const wd = weekdayOf(day)
  if (c.type === 'daily') return true
  if (c.type === 'weekly') return (c.weekdays || []).includes(wd)
  if (c.type === 'biweekly') {
    if (!(c.weekdays || []).includes(wd)) return false
    return Math.floor(dayDiff(BIWEEK_EPOCH, day) / 14) % 2 === (c.parity ?? 0)
  }
  return (c.monthDays || []).includes(Number(day.slice(8, 10)))
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
    `SELECT t.id AS task_id, t.title, t.note, t.cadence, t.responsible_member_id, m.name AS responsible_name
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
    // S75：适用判定按周期对象（兼容 NULL → daily 缺省）；weekdays/weekdaysLabel 为派生出参
    const cadence = parseCadence(t.cadence) ?? { type: 'daily' }
    const cells = days.map((day) => {
      const r = records.get(`${t.task_id}|${day}`) || null
      return {
        day,
        applicable: isApplicableDay(cadence, day),
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
      cadence, cadenceLabel: cadenceLabel(cadence),
      weekdays: cadenceWeekdays(cadence), weekdaysLabel: cadenceLabel(cadence),
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
 * progress 事件 + 审计。可补过去日期、拒绝未来日期（北京日）；不适用日 400（S75 起按 cadence 判定）；
 * 备注 ≤200 字；终态项目 409 只读。
 * origin：web（页面格子）| bot（机器人 checkin_task，事件归因 sourcePlatform/generatedBy 随通道）。
 * now：时钟注入（getDailyBoard 同款；缺省真实时刻）。
 */
export function setDayStatus(db, { projectId, taskId, day, status, note }, by, { origin = 'web', sourcePlatform, now = Date.now() } = {}) {
  const project = assertRoutineProject(db, projectId)
  if (project.status === 'closed' || project.status === 'cancelled') {
    throw Object.assign(new Error('项目已结项/取消，周视图只读（S29 终态不可逆）'), { statusCode: 409 })
  }
  const task = db.prepare(
    `SELECT t.id, t.title, t.kind, t.cadence, t.project_id FROM tasks t WHERE t.id = ? AND t.deleted_at IS NULL`
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
  if (dayStr > today(now)) {
    throw Object.assign(new Error('不能给未来日期打卡（可补过去日期）'), { statusCode: 400 })
  }
  const cadence = parseCadence(task.cadence) ?? { type: 'daily' }
  if (!isApplicableDay(cadence, dayStr)) {
    throw Object.assign(new Error(`该任务在 ${dayStr} 不适用（周期：${cadenceLabel(cadence)}）`), { statusCode: 400 })
  }
  const nextStatus = assertValue('dayStatus', String(status))
  const cleanNote = normalizeTaskNote(note) ?? null
  if (cleanNote && nextStatus === 'pending') {
    throw Object.assign(new Error('未做状态不带备注（备注随完成/跳过记录保留）'), { statusCode: 400 })
  }

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
    `SELECT id, title, cadence FROM tasks
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
