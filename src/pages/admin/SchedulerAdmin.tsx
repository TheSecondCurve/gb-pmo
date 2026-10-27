import { useEffect, useState } from 'react'
import { api } from '../../api'
import { useStore } from '../../store'
import { Badge, Btn, Card, Empty, Field, Spinner, Tabs, inputCls } from '../../components/ui'
import { fmtDateTime } from '../../fmt'
import { ADMIN_SECTIONS } from './sections'

// S67（v0.75，K53）：配置台「定时任务」集中页——全部调度任务一页配 cron + 启用开关，
// 保存即热生效（server 调度器心跳每分钟读配置）。任务清单与说明和 server/brain/scheduler.js TASKS 对应。
// v0.77（K58）：每任务「运行」按钮（S67-5 手动触发，与定时同一执行体，判重语义一致）。

const TABS = ADMIN_SECTIONS.find((s) => s.key === 'scheduler')!.tabs

interface SchedulerCfg { [key: string]: string | boolean }

const TASK_META: { key: string; cronKey: string; enabledKey: string; label: string; desc: string }[] = [
  { key: 'extraction', cronKey: 'extractionCron', enabledKey: 'extractionEnabled', label: '信息更新对齐', desc: '拉取绑定群新消息并抽取沉淀 + 群进展播报（S18/S60）' },
  { key: 'alerts', cronKey: 'alertCron', enabledKey: 'alertEnabled', label: '预警提醒', desc: '逾期/负载/沉默预警巡检 + 纯提醒到期推送（S7/S57）' },
  { key: 'report', cronKey: 'reportCron', enabledKey: 'reportEnabled', label: '日报提醒', desc: '按人视角日报私信，当日已发不重复（S6）' },
  { key: 'morning', cronKey: 'morningCron', enabledKey: 'morningEnabled', label: '每日项目群晨报', desc: '项目群推送当日盘面：概况/逾期/近期开工/动态，LLM 综述（S68）' },
  { key: 'calendarSync', cronKey: 'calendarSyncCron', enabledKey: 'calendarSyncEnabled', label: '项目日历同步', desc: '项目日程与飞书日历对账同步（S22，初始化在「外部依赖→飞书」）' },
  { key: 'backup', cronKey: 'backupCron', enabledKey: 'backupEnabled', label: '数据库备份', desc: '异地备份（存储配置在「运维诊断→数据库备份」，未配全自动跳过，S34）' },
  { key: 'digest', cronKey: 'digestCron', enabledKey: 'digestEnabled', label: '每周梳理与周报', desc: '牵头人项目梳理 + 老板周报，周级幂等（S49）' },
]

/** 手动运行结果一行摘要：晨报/周报类 {results:[...]} 汇总数，其余截断 JSON。 */
function summarizeRun(result: unknown): string {
  if (result && typeof result === 'object' && 'results' in result && Array.isArray((result as { results: unknown[] }).results)) {
    const rs = (result as { results: { pushed?: boolean; skipped?: boolean }[] }).results
    const pushed = rs.filter((r) => r.pushed).length
    const skipped = rs.filter((r) => r.skipped).length
    const failed = rs.length - pushed - skipped
    return `共 ${rs.length} 项：推送 ${pushed} · 跳过 ${skipped}${failed ? ` · 失败 ${failed}` : ''}`
  }
  const s = JSON.stringify(result)
  return s && s !== 'null' ? s.slice(0, 160) : '已执行'
}

export default function SchedulerAdmin({ tab }: { tab: string }) {
  const nav = (key: string) => { location.hash = `#/admin/scheduler/${key}` }
  return (
    <div>
      <Tabs tabs={TABS} value={tab} onChange={nav} />
      {tab === 'tasks' && <TasksTab />}
      {tab === 'runs' && <RunsTab />}
    </div>
  )
}

function TasksTab() {
  const { toast } = useStore()
  const [sched, setSched] = useState<SchedulerCfg | null>(null)
  const [fireAfterHour, setFireAfterHour] = useState<number | null>(null)
  const [running, setRunning] = useState('')
  const [runOut, setRunOut] = useState<Record<string, string>>({})

  const refresh = async () => {
    const s = await api.settings()
    setSched(s.scheduler as SchedulerCfg)
    setFireAfterHour((s.reminder as { fireAfterHour: number }).fireAfterHour)
  }
  useEffect(() => { void refresh() }, [])
  if (!sched || fireAfterHour === null) return <Spinner />

  const saveSched = async () => {
    try {
      await api.putSetting('scheduler', sched)
      toast('调度配置已保存（保存即热生效，无需重启）')
    } catch (e) { toast((e as Error).message, 'bad') }
  }
  const saveReminder = async () => {
    try {
      await api.putSetting('reminder', { fireAfterHour })
      toast('提醒门槛已保存')
    } catch (e) { toast((e as Error).message, 'bad') }
  }

  // S67-5：手动立即运行一次（与定时同一执行体；晨报/周报判重语义与定时一致，当日已推会跳过）
  const runTask = async (key: string) => {
    setRunning(key)
    try {
      const r = await api.schedulerRun(key)
      setRunOut((o) => ({ ...o, [key]: r.ok ? `✅ ${summarizeRun(r.result)}` : `❌ ${r.error}` }))
      if (!r.ok) toast(r.error || '执行失败', 'bad')
    } catch (e) {
      setRunOut((o) => ({ ...o, [key]: `❌ ${(e as Error).message}` }))
      toast((e as Error).message, 'bad')
    } finally { setRunning('') }
  }

  return (
    <div className="space-y-4">
      <Card title="大脑调度（S18，v0.7）：标准 cron「分 时 日 月 周」+ 每任务开关，保存即生效无需重启">
        <div className="space-y-3">
          {TASK_META.map((t) => (
            <div key={t.cronKey} className="flex flex-wrap items-end gap-x-3 gap-y-1">
              <Field label={t.label}>
                <input
                  className={inputCls + ' font-mono !w-40'}
                  value={String(sched[t.cronKey] ?? '')}
                  onChange={(e) => setSched({ ...sched, [t.cronKey]: e.target.value })}
                />
              </Field>
              <label className="flex items-center gap-1 pb-2 text-[12px]">
                <input
                  type="checkbox"
                  checked={Boolean(sched[t.enabledKey])}
                  onChange={(e) => setSched({ ...sched, [t.enabledKey]: e.target.checked })}
                />
                启用
              </label>
              <p className="pb-2 text-[12px] text-[var(--color-ink-soft)]">{t.desc}</p>
              <div className="flex items-center gap-2 pb-2">
                <Btn disabled={running !== ''} onClick={() => void runTask(t.key)}>{running === t.key ? '执行中…' : '运行'}</Btn>
                {runOut[t.key] && <span className="text-[12px]">{runOut[t.key]}</span>}
              </div>
            </div>
          ))}
        </div>
        <div className="mt-3">
          <Btn kind="primary" onClick={() => void saveSched()}>保存</Btn>
        </div>
        <p className="mt-2 text-[12px] leading-5 text-[var(--color-ink-soft)]">
          调度器随进程默认运行，心跳每分钟按配置判定。支持 *、*/n、a-b、a,b 与数字（周 0/7 均为周日）。
          日报停机错过时点当日补发、当日已发不重复；晨报不补跑（v0.77：重启/停机跨过时点当日不再自动发，可点「运行」手动触发，当日已推项目判重跳过）。
          「运行」= 与定时同一执行体立即跑一次，判重语义与定时完全一致。
        </p>
      </Card>
      <Card title="纯提醒发送门槛（S57）：提醒日当天北京时间过点后首个预警巡检周期触发，凌晨静默">
        <div className="flex items-end gap-3">
          <Field label="纯提醒发送门槛（北京时，0~23）">
            <input
              type="number" min={0} max={23} step={1}
              className={inputCls + ' !w-32'}
              value={fireAfterHour}
              onChange={(e) => setFireAfterHour(Number(e.target.value))}
            />
          </Field>
          <Btn kind="primary" onClick={() => void saveReminder()}>保存门槛</Btn>
        </div>
      </Card>
    </div>
  )
}

// S67-6（v0.77，K59）：运行记录——cron 与手动触发的统一台账（scheduler_runs），最近 50 条新→旧。
const TASK_LABELS: Record<string, string> = Object.fromEntries(TASK_META.map((t) => [t.key, t.label]))

interface RunRow {
  id: number; task: string; origin: string; startedAt: number; durationMs: number
  ok: number; summary?: string | null; memberName?: string | null
}

function RunsTab() {
  const [runs, setRuns] = useState<RunRow[] | null>(null)
  const [err, setErr] = useState('')
  const refresh = async () => {
    try { setErr(''); setRuns((await api.schedulerRuns()).runs) } catch (e) { setErr((e as Error).message) }
  }
  useEffect(() => { void refresh() }, [])
  return (
    <Card title="运行记录（S67-6）：定时（cron）与手动「运行」统一台账——成败 / 耗时 / 摘要，手动触发带操作人">
      <div className="mb-3 flex items-center gap-2">
        <Btn onClick={() => void refresh()}>刷新</Btn>
        {err && <span className="text-[12px] text-[var(--color-bad, #b91c1c)]">❌ {err}</span>}
      </div>
      {!runs ? <Spinner /> : runs.length === 0 ? (
        <Empty hint="暂无记录——下一次 cron 触发或手动「运行」后会出现在这里（台账自 v0.77 上线起记，不回填历史）" />
      ) : (
        <div className="space-y-1">
          {runs.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 border-t border-[var(--color-line)] py-1 text-[12px] first:border-t-0">
              <span className="num">{fmtDateTime(r.startedAt)}</span>
              <span>{TASK_LABELS[r.task] ?? r.task}</span>
              <Badge tone={r.ok ? 'ok' : 'bad'}>{r.ok ? '成功' : '失败'}</Badge>
              <span className="text-[var(--color-ink-soft)]">{r.origin === 'cron' ? '定时' : `手动${r.memberName ? ` · ${r.memberName}` : ''}`}</span>
              <span className="num text-[var(--color-ink-soft)]">{r.durationMs}ms</span>
              {r.summary && <span className="num max-w-full break-all text-[var(--color-ink-soft)]">{r.summary}</span>}
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}
