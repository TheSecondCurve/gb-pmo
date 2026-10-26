import { useEffect, useState } from 'react'
import { api } from '../../api'
import { useStore } from '../../store'
import { Btn, Card, Field, Spinner, Tabs, inputCls } from '../../components/ui'
import { ADMIN_SECTIONS } from './sections'

// S67（v0.75，K53）：配置台「定时任务」集中页——全部调度任务一页配 cron + 启用开关，
// 保存即热生效（server 调度器心跳每分钟读配置）。任务清单与说明和 server/brain/scheduler.js TASKS 对应。

const TABS = ADMIN_SECTIONS.find((s) => s.key === 'scheduler')!.tabs

interface SchedulerCfg { [key: string]: string | boolean }

const TASK_META: { cronKey: string; enabledKey: string; label: string; desc: string }[] = [
  { cronKey: 'extractionCron', enabledKey: 'extractionEnabled', label: '信息更新对齐', desc: '拉取绑定群新消息并抽取沉淀 + 群进展播报（S18/S60）' },
  { cronKey: 'alertCron', enabledKey: 'alertEnabled', label: '预警提醒', desc: '逾期/负载/沉默预警巡检 + 纯提醒到期推送（S7/S57）' },
  { cronKey: 'reportCron', enabledKey: 'reportEnabled', label: '日报提醒', desc: '按人视角日报私信，当日已发不重复（S6）' },
  { cronKey: 'morningCron', enabledKey: 'morningEnabled', label: '每日项目群晨报', desc: '项目群推送当日盘面：概况/逾期/近期开工/动态，LLM 综述（S68）' },
  { cronKey: 'calendarSyncCron', enabledKey: 'calendarSyncEnabled', label: '项目日历同步', desc: '项目日程与飞书日历对账同步（S22，初始化在「外部依赖→飞书」）' },
  { cronKey: 'backupCron', enabledKey: 'backupEnabled', label: '数据库备份', desc: '异地备份（存储配置在「运维诊断→数据库备份」，未配全自动跳过，S34）' },
  { cronKey: 'digestCron', enabledKey: 'digestEnabled', label: '每周梳理与周报', desc: '牵头人项目梳理 + 老板周报，周级幂等（S49）' },
]

export default function SchedulerAdmin({ tab }: { tab: string }) {
  const nav = (key: string) => { location.hash = `#/admin/scheduler/${key}` }
  return (
    <div>
      <Tabs tabs={TABS} value={tab} onChange={nav} />
      {tab === 'tasks' && <TasksTab />}
    </div>
  )
}

function TasksTab() {
  const { toast } = useStore()
  const [sched, setSched] = useState<SchedulerCfg | null>(null)
  const [fireAfterHour, setFireAfterHour] = useState<number | null>(null)

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
            </div>
          ))}
        </div>
        <div className="mt-3">
          <Btn kind="primary" onClick={() => void saveSched()}>保存</Btn>
        </div>
        <p className="mt-2 text-[12px] leading-5 text-[var(--color-ink-soft)]">
          调度器随进程默认运行，心跳每分钟按配置判定。支持 *、*/n、a-b、a,b 与数字（周 0/7 均为周日）。
          日报停机错过时点当日补发、当日已发不重复；晨报按项目当日判重（重启补跑安全）。
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
