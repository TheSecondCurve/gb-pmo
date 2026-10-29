import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../api'
import { useStore } from '../store'
import { bjToday } from '../fmt'
import { Badge, Btn, Card, Empty, InlineSelect, InlineText, Spinner } from './ui'
import {
  BOARD_SPAN_LABEL, DAY_STATUS_LABEL, DAY_STATUS_TONE, WEEKDAY_SHORT,
  cadenceShortLabel, type BoardSpan, type Cadence, type DailyBoardData, type DailyCell,
} from '../types'

// S69（v0.80，K64）：常态项目「执行视图」——行=常态任务、列=窗口内逐日的打卡二维表（代替甘特区块）。
// v0.81（K65，S69-8）：窗口三档 span（周/双周/月）Tabs 切换即持久化为项目默认（WYSIWYG）；
// 窗口数学唯一在引擎——导航只消费响应的 prevAnchor/nextAnchor，本组件不做任何日期推算（今天判定除外）。
// 默认当前期、可前后切换/回本期；今天列高亮、不适用格置灰；月/双周宽表格横向滚动、周一分隔线。

function weekdayOf(day: string): number {
  const n = new Date(Date.parse(`${day}T00:00:00Z`)).getUTCDay()
  return n === 0 ? 7 : n
}

const SPANS: BoardSpan[] = ['week', 'biweek', 'month']

export default function DailyWeekGrid({ projectId, defaultSpan = 'week', readonly, onChanged }: {
  projectId: number; defaultSpan?: BoardSpan; readonly: boolean; onChanged?: () => void | Promise<void>
}) {
  const { toast } = useStore()
  const [board, setBoard] = useState<DailyBoardData | null>(null)
  const [span, setSpan] = useState<BoardSpan>(defaultSpan)
  const [anchor, setAnchor] = useState('') // '' = 当前期（缺省）
  const today = bjToday()

  const load = useCallback(async () => {
    setBoard(await api.dailyBoard(projectId, { anchor: anchor || undefined, span }))
  }, [projectId, anchor, span])
  useEffect(() => { void load() }, [load])

  const apply = async (taskId: number, cell: DailyCell, patch: { status?: string; note?: string }) => {
    try {
      await api.setDayStatus(projectId, {
        taskId, day: cell.day,
        status: patch.status ?? cell.status,
        ...(patch.note !== undefined ? { note: patch.note } : {}),
      })
      await load()
      await onChanged?.() // 打卡落讨论面事件，父组件刷新事件流
    } catch (e) {
      toast((e as Error).message, 'bad')
    }
  }

  // 切窗口：立即换视图，并持久化为项目默认（WYSIWYG；失败仅提示不回滚——视图本地仍可用）
  const switchSpan = (next: BoardSpan) => {
    if (next === span) return
    setSpan(next)
    setAnchor('')
    void api.patchProject(projectId, { boardSpan: next }).catch((e) => toast((e as Error).message, 'bad'))
  }

  if (!board) return <Spinner />
  const isCurrentPeriod = board.days.includes(today)
  const wide = board.days.length > 7 // 双周/月：窄格宽表（横向滚动）
  const dayShort = (d: string) => d.slice(5).replace('-', '/')

  return (
    <Card
      title={`01 · 执行视图 · ${board.start} ~ ${board.end}${isCurrentPeriod ? '（本期）' : ''}`}
      actions={(
        <div data-testid="daily-week-nav" className="flex flex-wrap items-center gap-1.5">
          {/* 窗口 Tabs：切换即持久化为项目默认（S69-8/K65） */}
          <span className="flex overflow-hidden rounded-full border border-[var(--color-line-strong)]" role="tablist" aria-label="执行视图窗口">
            {SPANS.map((s) => (
              <button
                key={s} type="button" role="tab" aria-selected={span === s}
                className={`px-2.5 py-1 text-[12px] transition-colors ${
                  span === s ? 'bg-[var(--color-ink)] font-medium text-[var(--color-card)]' : 'text-[var(--color-ink-soft)] hover:bg-[var(--color-brand-soft)]'
                }`}
                onClick={() => switchSpan(s)}>{BOARD_SPAN_LABEL[s]}</button>
            ))}
          </span>
          <Btn small onClick={() => setAnchor(board.prevAnchor)}>← 上一期</Btn>
          {!isCurrentPeriod && <Btn small onClick={() => setAnchor('')}>回本期</Btn>}
          <Btn small onClick={() => setAnchor(board.nextAnchor)}>下一期 →</Btn>
        </div>
      )}
    >
      <div className="mb-3 flex flex-wrap items-center gap-2 text-[12px] text-[var(--color-ink-soft)]">
        <Badge tone="ok">完成 {board.summary.done}</Badge>
        <Badge tone="warn">跳过 {board.summary.skip}</Badge>
        <Badge tone="muted">待做 {board.summary.pending}</Badge>
        <span>共 {board.summary.applicableCells} 个适用格（未做=无记录，K64 不预生成实例）</span>
      </div>
      {board.tasks.length === 0 ? <Empty hint="暂无常态任务——在下方任务面添加（每行一条，选周期）" /> : (
        <div className="overflow-x-auto">
          <table
            data-testid="daily-week-grid" className={`w-full text-[13px] ${wide ? 'text-[12px]' : 'min-w-[52rem]'}`}
            style={wide ? { minWidth: `${Math.ceil(board.days.length * 5.5)}rem` } : undefined}
          >
            <thead className="text-left text-[10px] font-medium tracking-[0.04em] text-[var(--color-ink-soft)]">
              <tr className="border-b border-[var(--color-line)] [&>th]:px-2 [&>th]:py-2.5">
                <th className={`min-w-[13rem] ${wide ? 'sticky left-0 z-10 bg-[var(--color-card)]' : ''}`}>常态任务</th>
                {board.days.map((d) => (
                  <th
                    key={d} data-testid="day-col" data-day={d}
                    className={`text-center ${d === today ? 'bg-[var(--color-brand-soft)]/50 text-[var(--color-brand)]' : ''} ${wide && weekdayOf(d) === 1 ? 'border-l border-[var(--color-line-strong)]' : ''}`}
                  >
                    <div>周{WEEKDAY_SHORT[weekdayOf(d)]}</div>
                    <div className="num font-normal">{wide ? d.slice(8) : dayShort(d)}</div>
                  </th>
                ))}
                <th className="text-center">本期</th>
              </tr>
            </thead>
            <tbody>
              {board.tasks.map((t) => (
                <tr key={t.taskId} data-testid="daily-task-row" className="border-b border-[var(--color-line)] last:border-0 [&>td]:px-2 [&>td]:py-2.5">
                  <td className={wide ? 'sticky left-0 z-10 bg-[var(--color-card)]' : ''}>
                    <div className="flex flex-wrap items-baseline gap-1.5">
                      <span className="num mr-0.5 text-[12px] text-[var(--color-ink-soft)]">#{t.taskId}</span>
                      <span className="font-medium">{t.title}</span>
                      <Badge tone="muted">{t.weekdaysLabel}</Badge>
                      {t.responsibleName && <span className="text-[11px] text-[var(--color-ink-soft)]">{t.responsibleName}</span>}
                    </div>
                  </td>
                  {t.cells.map((c) => (
                    <td
                      key={c.day}
                      className={`text-center align-top ${c.day === today ? 'bg-[var(--color-brand-soft)]/25' : ''} ${wide && weekdayOf(c.day) === 1 ? 'border-l border-[var(--color-line-strong)]' : ''}`}
                    >
                      {!c.applicable ? (
                        <span className="text-[var(--color-ink-faint)]" title="该任务本日不适用（周期未命中：星期/隔周序列/每月几号）">—</span>
                      ) : readonly ? (
                        <div className="flex flex-col items-center gap-0.5">
                          <Badge tone={DAY_STATUS_TONE[c.status]} data-testid="day-cell">{DAY_STATUS_LABEL[c.status]}</Badge>
                          {c.note && <span className="block max-w-[6rem] truncate text-[11px] text-[var(--color-ink-soft)]" title={c.note}>{c.note}</span>}
                        </div>
                      ) : (
                        <div className="flex flex-col items-center gap-0.5">
                          <InlineSelect
                            value={c.status} options={DAY_STATUS_LABEL} tones={DAY_STATUS_TONE}
                            onSubmit={(v) => void apply(t.taskId, c, { status: v })} />
                          {c.status !== 'pending' && (
                            <InlineText
                              value={c.note} placeholder="备注" className={`block text-[11px] text-[var(--color-ink-soft)] ${wide ? 'max-w-[4rem]' : 'max-w-[6rem]'}`}
                              onSubmit={(v) => void apply(t.taskId, c, { note: v })} />
                          )}
                          {c.source === 'bot' && <span className="text-[10px] text-[var(--color-ink-faint)]" title={`机器人打卡（${c.operatorName || ''}）`}>🤖</span>}
                        </div>
                      )}
                    </td>
                  ))}
                  <td className="num text-center text-[12px] text-[var(--color-ink-soft)]" title="本期完成 / 适用格">{t.periodDone}/{t.periodApplicable}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-[var(--color-line)] text-[11px] text-[var(--color-ink-soft)] [&>td]:px-2 [&>td]:py-2">
                <td className={wide ? 'sticky left-0 z-10 bg-[var(--color-card)]' : ''}>当日完成</td>
                {board.summary.perDay.map((d) => (
                  <td key={d.day} className={`num text-center ${d.day === today ? 'text-[var(--color-brand)]' : ''}`}>{d.done}{d.skip ? `（跳${d.skip}）` : ''}</td>
                ))}
                <td className="num text-center">{board.summary.done}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      <div className="mt-2 text-[11px] text-[var(--color-ink-soft)]">
        格子就地打卡（可补过去日期、不可打未来）；群里 @机器人 说「XX 打卡 / 今天 XX 跳过」同样生效（S69-4）。备注 ≤200 字随完成/跳过记录保留。窗口切换（周/双周/月）即保存为本项目默认。
      </div>
    </Card>
  )
}

/** 周期选择器（S69 适用星期 → S75 四档）：每天 / 每周（星期组合）/ 每两周（星期组合 + 隔周序列）/
 *  每月（1~31 号组合，当月无该日不适用）。任务面行内与新建行共用。
 *  弹层沿用 v0.86.1 修复：portal 到 document.body + fixed 定位——不被任务表格 overflow-x-auto 与页面滚动
 *  容器（app-canvas）裁切；按触发器实测矩形定位，近屏底自动向上翻转、横向收进视口；滚动/缩放跟随重算；Esc 关闭。
 *  层叠（root 上下文）：遮罩 z-20 / 弹层 z-30——高于页面内容，低于 Modal z-40 与 toast z-50。
 *  双周序列（parity）说明：双周任务分两条隔周序列（自纪元锚 2024-01-01 起每 14 天一期交替）；
 *  序列 A/B 保存后以双周执行视图亮灯格子为准，不对就换一档（适用判定唯一在引擎，前端不重复实现）。 */
const POPUP_W = 272 // 每月档 31 枚 chip 阵列所需宽度
const POPUP_EST_H = 220 // 弹层预估高度（保守值：jsdom 无布局量不出真实高度，宁可早翻不裁切）
const POPUP_GAP = 4

type CadenceDraft = { type: Cadence['type']; weekdays: number[]; parity: 0 | 1; monthDays: number[] }

const draftOf = (c: Cadence | null | undefined): CadenceDraft => ({
  type: c?.type ?? 'daily',
  weekdays: c?.type === 'weekly' || c?.type === 'biweekly' ? c.weekdays : [],
  parity: c?.type === 'biweekly' ? c.parity : 0,
  monthDays: c?.type === 'monthly' ? c.monthDays : [],
})

const draftValid = (d: CadenceDraft) =>
  d.type === 'daily' ? true : d.type === 'monthly' ? d.monthDays.length > 0 : d.weekdays.length > 0

const draftToCadence = (d: CadenceDraft): Cadence =>
  d.type === 'daily' ? { type: 'daily' }
    : d.type === 'weekly' ? { type: 'weekly', weekdays: [...d.weekdays].sort((a, b) => a - b) }
    : d.type === 'biweekly' ? { type: 'biweekly', weekdays: [...d.weekdays].sort((a, b) => a - b), parity: d.parity }
    : { type: 'monthly', monthDays: [...d.monthDays].sort((a, b) => a - b) }

export function CadencePicker({ value, onChange, disabled }: {
  value: Cadence | null | undefined; onChange: (v: Cadence) => void; disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<CadenceDraft>(draftOf(value))
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  useEffect(() => setDraft(draftOf(value)), [value])
  const setType = (type: Cadence['type']) => setDraft((cur) => ({ ...cur, type }))
  const toggleWeekday = (d: number) => setDraft((cur) => ({
    ...cur,
    weekdays: cur.weekdays.includes(d) ? cur.weekdays.filter((x) => x !== d) : [...cur.weekdays, d].sort((a, b) => a - b),
  }))
  const toggleMonthDay = (d: number) => setDraft((cur) => ({
    ...cur,
    monthDays: cur.monthDays.includes(d) ? cur.monthDays.filter((x) => x !== d) : [...cur.monthDays, d].sort((a, b) => a - b),
  }))

  const place = useCallback(() => {
    const btn = btnRef.current
    if (!btn) return
    const r = btn.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    const spaceBelow = vh - r.bottom - POPUP_GAP
    const spaceAbove = r.top - POPUP_GAP
    // 下方展开优先；空间不足且上方更宽裕时上翻。两分支都以 vh-EST_H 封顶：触发器被滚出视口
    // （跟随重算有节流延迟的退化场景）时弹层仍完整留在视口内
    const top = spaceBelow >= POPUP_EST_H || spaceBelow >= spaceAbove
      ? Math.min(r.bottom + POPUP_GAP, Math.max(POPUP_GAP, vh - POPUP_EST_H - POPUP_GAP))
      : Math.max(POPUP_GAP, Math.min(r.top - POPUP_EST_H - POPUP_GAP, vh - POPUP_EST_H - POPUP_GAP))
    const left = Math.max(POPUP_GAP, Math.min(r.left, vw - POPUP_W - POPUP_GAP))
    setPos((cur) => (!cur || cur.top !== top || cur.left !== left ? { top, left } : cur))
  }, [])

  useLayoutEffect(() => {
    if (!open) return
    place() // 首帧定位在绘制前完成（pos 未就绪前弹层隐藏，不闪 (0,0)）
    // 滚动/缩放跟随：scroll(capture)/resize 事件 + 100ms 轮询兜底——实测部分 webview 对容器
    // 程序化滚动不派发 scroll 事件、rAF 也不打点（不主动合成时）；轮询保证任何环境贴住触发器，
    // place 内坐标未变不 setPos，无重渲染开销
    const timer = setInterval(place, 100)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', esc)
    return () => {
      clearInterval(timer)
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('keydown', esc)
    }
  }, [open, place])

  const TYPES: Array<{ key: Cadence['type']; label: string }> = [
    { key: 'daily', label: '每天' }, { key: 'weekly', label: '每周' }, { key: 'biweekly', label: '每两周' }, { key: 'monthly', label: '每月' },
  ]

  return (
    <span className="relative inline-block" data-testid="cadence-picker">
      <button
        type="button" disabled={disabled} ref={btnRef}
        className="cursor-pointer rounded-full bg-[var(--color-panel)] px-2 py-1 text-[12px] font-medium text-[var(--color-ink-soft)] transition-colors hover:bg-[var(--color-brand-soft)] disabled:cursor-not-allowed disabled:opacity-50"
        onClick={() => { setOpen(!open); setDraft(draftOf(value)) }}>
        {cadenceShortLabel(value)}
      </button>
      {open && !disabled && createPortal(
        <>
          <div data-testid="cadence-picker-backdrop" className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div
            data-testid="cadence-picker-pop"
            className="fixed z-30 w-[17rem] rounded-[5px] border border-[var(--color-line)] bg-[var(--color-card)] p-2.5 shadow-[var(--shadow-editorial)]"
            style={pos ? { top: pos.top, left: pos.left } : { visibility: 'hidden' }}>
            <div className="mb-2.5 flex overflow-hidden rounded-full border border-[var(--color-line-strong)]" role="tablist" aria-label="周期档位">
              {TYPES.map((t) => (
                <button
                  key={t.key} type="button" role="tab" aria-selected={draft.type === t.key}
                  className={`flex-1 px-2 py-1 text-[12px] transition-colors ${
                    draft.type === t.key ? 'bg-[var(--color-ink)] font-medium text-[var(--color-card)]' : 'text-[var(--color-ink-soft)] hover:bg-[var(--color-brand-soft)]'
                  }`}
                  onClick={() => setType(t.key)}>{t.label}</button>
              ))}
            </div>
            {draft.type === 'daily' && (
              <div className="mb-2 text-[11px] text-[var(--color-ink-soft)]">窗口内每天适用（缺省档）。</div>
            )}
            {(draft.type === 'weekly' || draft.type === 'biweekly') && (
              <>
                <div className="mb-1.5 text-[10px] font-medium tracking-[0.04em] text-[var(--color-ink-soft)]">适用星期（≥1 天）</div>
                <div className="mb-2 flex flex-wrap gap-1">
                  {WEEKDAY_SHORT.slice(1).map((w, i) => {
                    const d = i + 1
                    const on = draft.weekdays.includes(d)
                    return (
                      <button
                        key={d} type="button" aria-pressed={on}
                        className={`h-7 w-7 rounded-full border text-[12px] transition-colors ${
                          on ? 'border-[var(--color-brand)] bg-[var(--color-brand)] text-white' : 'border-[var(--color-line-strong)] text-[var(--color-ink-soft)]'
                        }`}
                        onClick={() => toggleWeekday(d)}>{w}</button>
                    )
                  })}
                </div>
              </>
            )}
            {draft.type === 'biweekly' && (
              <>
                <div className="mb-1.5 text-[10px] font-medium tracking-[0.04em] text-[var(--color-ink-soft)]">隔周序列（两条交替，自纪元锚 2024-01-01 起每 14 天一期）</div>
                <div className="mb-2 flex gap-1.5">
                  {([0, 1] as const).map((p) => (
                    <button
                      key={p} type="button" aria-pressed={draft.parity === p}
                      className={`flex-1 rounded-full border px-2 py-1 text-[11px] transition-colors ${
                        draft.parity === p ? 'border-[var(--color-brand)] bg-[var(--color-brand-soft)] font-medium text-[var(--color-brand)]' : 'border-[var(--color-line-strong)] text-[var(--color-ink-soft)]'
                      }`}
                      onClick={() => setDraft((cur) => ({ ...cur, parity: p }))}>
                      {p === 0 ? '序列 A（含 2024-01-01 的一期）' : '序列 B（隔期）'}
                    </button>
                  ))}
                </div>
                <div className="mb-2 text-[10px] leading-4 text-[var(--color-ink-faint)]">保存后以双周执行视图的亮灯格子为准；不对就换另一档。</div>
              </>
            )}
            {draft.type === 'monthly' && (
              <>
                <div className="mb-1.5 text-[10px] font-medium tracking-[0.04em] text-[var(--color-ink-soft)]">每月几号（≥1 天；当月没有该日则不适用，如 2 月无 30/31 号）</div>
                <div className="mb-2 grid grid-cols-7 gap-1">
                  {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => {
                    const on = draft.monthDays.includes(d)
                    return (
                      <button
                        key={d} type="button" aria-pressed={on}
                        className={`num h-6 rounded-full border text-[11px] transition-colors ${
                          on ? 'border-[var(--color-brand)] bg-[var(--color-brand)] text-white' : 'border-[var(--color-line-strong)] text-[var(--color-ink-soft)]'
                        }`}
                        onClick={() => toggleMonthDay(d)}>{d}</button>
                    )
                  })}
                </div>
              </>
            )}
            <div className="flex items-center justify-end gap-1.5 border-t border-[var(--color-line)] pt-2">
              <Btn small kind="ghost" onClick={() => setOpen(false)}>取消</Btn>
              <Btn small kind="primary" disabled={!draftValid(draft)} onClick={() => { onChange(draftToCadence(draft)); setOpen(false) }}>确定</Btn>
            </div>
          </div>
        </>,
        document.body,
      )}
    </span>
  )
}
