import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { useStore } from '../store'
import { bjToday } from '../fmt'
import { Badge, Btn, Card, Empty, InlineSelect, InlineText, Spinner } from './ui'
import {
  BOARD_SPAN_LABEL, DAY_STATUS_LABEL, DAY_STATUS_TONE, WEEKDAY_SHORT,
  type BoardSpan, type DailyBoardData, type DailyCell,
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
      {board.tasks.length === 0 ? <Empty hint="暂无常态任务——在下方任务面添加（每行一条，选适用星期）" /> : (
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
                        <span className="text-[var(--color-ink-faint)]" title="该任务本日不适用（适用星期未勾选）">—</span>
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

/** 适用星期勾选器（S69）：7 天 toggle + 「每天」快捷；空选不可保存（≥1 天）。任务面行内与新建行共用。 */
export function WeekdayPicker({ value, onChange, disabled }: {
  value: number[]; onChange: (v: number[]) => void; disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<number[]>(value)
  useEffect(() => setDraft(value), [value])
  const label = value.length === 7 ? '每天' : value.map((d) => WEEKDAY_SHORT[d]).join('、')
  const toggle = (d: number) => setDraft((cur) => (cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d].sort((a, b) => a - b)))
  return (
    <span className="relative inline-block" data-testid="weekday-picker">
      <button
        type="button" disabled={disabled}
        className="cursor-pointer rounded-full bg-[var(--color-panel)] px-2 py-1 text-[12px] font-medium text-[var(--color-ink-soft)] transition-colors hover:bg-[var(--color-brand-soft)] disabled:cursor-not-allowed disabled:opacity-50"
        onClick={() => { setOpen(!open); setDraft(value) }}>
        {value.length === 7 ? '每天' : `每周${label}`}
      </button>
      {open && !disabled && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div className="absolute left-0 z-30 mt-1 w-56 rounded-[5px] border border-[var(--color-line)] bg-[var(--color-card)] p-2.5 shadow-[var(--shadow-editorial)]">
            <div className="mb-2 flex flex-wrap gap-1">
              {WEEKDAY_SHORT.slice(1).map((w, i) => {
                const d = i + 1
                const on = draft.includes(d)
                return (
                  <button
                    key={d} type="button" aria-pressed={on}
                    className={`h-7 w-7 rounded-full border text-[12px] transition-colors ${
                      on ? 'border-[var(--color-brand)] bg-[var(--color-brand)] text-white' : 'border-[var(--color-line-strong)] text-[var(--color-ink-soft)]'
                    }`}
                    onClick={() => toggle(d)}>{w}</button>
                )
              })}
            </div>
            <div className="flex items-center justify-between">
              <Btn small kind="ghost" onClick={() => setDraft([1, 2, 3, 4, 5, 6, 7])}>每天</Btn>
              <Btn small kind="primary" disabled={!draft.length} onClick={() => { onChange(draft); setOpen(false) }}>确定</Btn>
            </div>
          </div>
        </>
      )}
    </span>
  )
}
