import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Sparkles } from 'lucide-react'
import { fmtDateTime } from '../fmt'
import { api } from '../api'
import { useStore } from '../store'
import { Badge, Btn, Card, Empty, Field, InlineSelect, InlineText, Modal, Spinner, inputCls } from '../components/ui'
import { PageMasthead, SectionHeading } from '../components/editorial'
import ProgressSchedule from '../components/ProgressSchedule'
import DailyWeekGrid, { WeekdayPicker } from '../components/DailyWeekGrid'
import { TASK_ROW_CLS, taskVisual } from '../progress'
import {
  EVENT_PINNED_COLS, EVENT_STATUS_LABEL, EVENT_TYPE_LABEL, MILESTONE_STATUS_LABEL, MILESTONE_STATUS_TONE,
  PRIORITY_LABEL, PROJECT_STATUS_LABEL, TASK_STATUS_LABEL, TASK_STATUS_TONE,
  type ChannelRow, type EventRow, type InitAssignmentRow, type Member, type ProjectDetail, type TaskRecordRow, type TaskRefRow, type WikiArchiveRun, type WikiBinding,
} from '../types'

/** S63（v0.68）：汇总归档运行阶段中文标签（wiki_archive_runs.stage）；S65：files=归档附件中。 */
const ARCHIVE_STAGE_LABEL: Record<string, string> = { fetch: '回读群消息', summarize: '汇总提炼', images: '搬运图片', files: '归档附件中', write: '写入页面' }

export default function ProjectDetail({ id }: { id: number }) {
  const { toast, member } = useStore()
  const [p, setP] = useState<ProjectDetail | null>(null)
  const [events, setEvents] = useState<EventRow[]>([])
  const [members, setMembers] = useState<Member[]>([])
  const [channels, setChannels] = useState<ChannelRow[]>([])
  const [closing, setClosing] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [binding, setBinding] = useState(false)
  const [digesting, setDigesting] = useState(false)
  const [recordsTaskId, setRecordsTaskId] = useState<number | null>(null)
  const [refsTask, setRefsTask] = useState<{ id: number; title: string } | null>(null)
  const [initAssigning, setInitAssigning] = useState(false)
  const [wiki, setWiki] = useState<WikiBinding | null>(null) // S61 知识库绑定
  const [bindingWiki, setBindingWiki] = useState(false)
  const [archiveRun, setArchiveRun] = useState<WikiArchiveRun | null>(null) // S63 汇总归档台账
  const [hiddenEventTypes, setHiddenEventTypes] = useState<string[]>([]) // S4-8 其他栏筛选：被隐藏的类型（默认空=全显）

  const refresh = useCallback(async () => {
    const [d, e, m, c, w, wa] = await Promise.all([
      api.project(id), api.projectEvents(id), api.members(), api.channels(), api.projectWiki(id), api.wikiArchive(id),
    ])
    setP(d); setEvents(e.events); setMembers(m.members); setChannels(c.channels.filter((ch) => ch.projectId === id)); setWiki(w.wiki); setArchiveRun(wa.run)
  }, [id])
  useEffect(() => { void refresh() }, [refresh])

  // S63：归档任务 running 期间轮询台账，完成/失败即停并提示（结果行随状态更新）
  useEffect(() => {
    if (archiveRun?.status !== 'running') return
    const timer = setTimeout(async () => {
      try {
        const next = (await api.wikiArchive(id)).run
        setArchiveRun(next)
        if (next?.status === 'done') toast('项目汇总已生成，点知识库卡片链接查看')
        if (next?.status === 'failed') toast(`项目汇总生成失败：${next.error ?? '未知错误'}`, 'bad')
      } catch { /* 轮询失败下一轮继续 */ }
    }, 2000)
    return () => clearTimeout(timer)
  }, [archiveRun, id, toast])

  // S63：触发汇总归档（400 未绑定/409 运行中的中文指引如实透出）
  const startArchive = async () => {
    try {
      const r = await api.startWikiArchive(id)
      setArchiveRun(r.run)
      toast('已开始生成项目汇总——全量回读群消息中，稍候自动刷新')
    } catch (e) {
      toast(e instanceof Error ? e.message : '启动失败', 'bad')
    }
  }

  if (!p) return <Spinner />
  const readonly = p.status === 'closed' || p.status === 'cancelled'
  // S69（K64）：常态项目——周视图代替甘特区块、任务面无状态/排期列（星期配置 + 每日打卡）
  const routine = p.kind === 'routine'
  // S17-12：渠道写权限与后端同构——管理员或该项目牵头人（通用群在配置台维护）
  const canManageChannels = !readonly && (member?.role === 'admin' || member?.id === p.leadMemberId)
  // S63：归档触发权限与渠道管理同口径、但不含 !readonly——结项项目正是归档主场景
  const canArchiveWiki = member?.role === 'admin' || member?.id === p.leadMemberId
  const activeMembers = members.filter((m) => m.status === 'active')
  const nameOf = (mid: number | null | undefined) => activeMembers.find((m) => m.id === mid)?.name || '（未指派）'

  // S4-7（v0.46/K25）：待确认建议一键批量处理——走 confirmEvent/rejectEvent 同口子，聚合回执
  const pendingSuggestions = events.filter((e) => e.status === 'pending')
  const batchDecide = async (action: 'confirm' | 'reject') => {
    const ids = pendingSuggestions.map((e) => e.id)
    if (!ids.length) return
    const r = action === 'confirm' ? await api.confirmEventsBatch(ids) : await api.rejectEventsBatch(ids)
    const done = ('confirmed' in r ? r.confirmed : r.rejected).length
    const failText = r.failed.length ? `，${r.failed.length} 条失败：${r.failed.map((f) => `#${f.id} ${f.message}`).join('；')}` : ''
    toast(`${action === 'confirm' ? '已生效' : '已驳回'} ${done} 条${failText}`)
    await refresh()
  }

  // S4-8（v0.47）：讨论面分栏——固定三栏（进展/风险·阻塞/财务记录）+「其他」栏（类型筛选，默认全显；
  // 未识别类型自动落其他栏不丢失）；各栏保持业务时间倒序（listEvents 返回序）
  const pinnedTypes = new Set(EVENT_PINNED_COLS.flatMap((c) => c.types))
  const otherEvents = events.filter((e) => !pinnedTypes.has(e.eventType))
  const otherTypes = [
    ...Object.keys(EVENT_TYPE_LABEL).filter((t) => !pinnedTypes.has(t)),
    ...[...new Set(otherEvents.map((e) => e.eventType))].filter((t) => !(t in EVENT_TYPE_LABEL) && !pinnedTypes.has(t)),
  ]
  const shownOther = otherEvents.filter((e) => !hiddenEventTypes.includes(e.eventType))
  const renderEvent = (e: EventRow) => (
    <li key={e.id} className="border-b border-[var(--color-line)] py-4 text-[13px] first:pt-0">
      <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px] text-[var(--color-ink-soft)]">
        <Badge tone={e.status === 'pending' ? 'warn' : e.status === 'effective' ? 'ok' : 'muted'}>{EVENT_STATUS_LABEL[e.status]}</Badge>
        <Badge tone="muted">{EVENT_TYPE_LABEL[e.eventType] || e.eventType}</Badge>
        <Badge tone={e.nature === 'suggestion' ? 'info' : 'muted'}>{e.nature === 'suggestion' ? '建议型' : '记录型'}</Badge>
        {e.generatedBy === 'extraction' && <Badge tone="muted">IM 抽取</Badge>}
        <span className="num">{fmtDateTime(e.businessTime)}</span>
        {e.speakerLabel && <span>{e.speakerLabel}</span>}
      </div>
      <div>{e.summary}</div>
      {e.status === 'pending' && (
        <div className="mt-2 flex gap-2">
          <Btn small kind="primary" onClick={async () => { await api.confirmEvent(e.id); toast('建议已确认生效'); await refresh() }}>确认生效</Btn>
          <Btn small onClick={async () => { await api.rejectEvent(e.id); toast('已驳回'); await refresh() }}>驳回</Btn>
        </div>
      )}
    </li>
  )

  return (
    <div className="space-y-8 md:space-y-10">
      <div><a className="editorial-link text-[12px] text-[var(--color-ink-soft)]" href="#/projects">← 返回项目组合</a></div>
      <PageMasthead
        kicker={`Project file / #${p.id}`}
        title={p.name}
        description={(
          <div className="flex flex-wrap items-center gap-2">
            <InlineSelect value={p.priority} options={PRIORITY_LABEL} onSubmit={async (v) => { await api.patchProject(id, { priority: v }); toast('优先级已调整并留痕'); await refresh() }} />
            <Badge tone={p.status === 'active' ? 'ok' : 'muted'}>{PROJECT_STATUS_LABEL[p.status] || p.status}</Badge>
            <span className="text-[12px] text-[var(--color-ink-soft)]">牵头人 {p.leadName}{p.clientName ? ` · 客户 ${p.clientName}` : ''}{readonly ? ' · 已归档只读' : ''}</span>
          </div>
        )}
        aside={(
          <div className="min-w-[180px] md:border-l md:border-[var(--color-line-strong)] md:pl-5">
            <div className="text-[9px] font-semibold tracking-[0.16em] text-[var(--color-ink-faint)]">
              {routine ? 'ROUTINE OPS' : 'DELIVERY DATE'}
            </div>
            {routine ? (
              <span className="mt-2 flex flex-wrap items-center gap-1.5 text-[12px] text-[var(--color-ink-soft)]">
                <Badge tone="info">常态项目</Badge>常态化运营 · 无交付日期 · 按周打卡
              </span>
            ) : (
              <span className="num mt-2 flex flex-wrap items-center gap-1.5 text-[12px] text-[var(--color-ink-soft)]">
                {readonly ? (p.planEndDate || '—') : (
                  <InlineText type="date" value={p.planEndDate} onSubmit={async (v) => {
                    try { await api.patchProject(id, { planEndDate: v }); toast('交付日期已更新'); await refresh() } catch (e) { toast((e as Error).message, 'bad') }
                  }} />
                )}
                {p.daysToDelivery != null && (p.daysToDelivery >= 0
                  ? <Badge tone={p.daysToDelivery <= 3 ? 'warn' : 'muted'}>{p.daysToDelivery === 0 ? '今日交付' : `剩 ${p.daysToDelivery} 天`}</Badge>
                  : <Badge tone="bad">超期 {-p.daysToDelivery} 天</Badge>)}
              </span>
            )}
          </div>
        )}
        actions={(
          <div className="flex max-w-[520px] flex-wrap gap-2 md:justify-end">
            <Btn onClick={async () => setDigesting(true)} disabled={digesting}><Sparkles aria-hidden="true" size={14} />生成梳理（S15）</Btn>
            {!readonly && <Btn kind="danger" onClick={() => setClosing(true)}>结项（S8）</Btn>}
            {!readonly && <Btn kind="ghost" onClick={() => setCancelling(true)}>取消项目</Btn>}
            {/* S37 硬删除：物理抹除全部数据（与「取消」的留痕语义互补），仅管理员，双重确认 */}
            {member?.role === 'admin' && (
              <Btn kind="ghost" onClick={async () => {
                if (!confirm(`彻底删除项目「${p.name}」？物理删除不可恢复：任务/里程碑/事件/渠道绑定等全部数据将从库中抹除（与「取消」的留痕语义不同）。`)) return
                if (!confirm(`再次确认：删除后仅存一条审计快照，数据不可恢复。确定删除「${p.name}」？`)) return
                try {
                  await api.deleteProject(p.id)
                  toast('项目已彻底删除')
                  location.hash = '#/projects'
                } catch (e) { toast((e as Error).message, 'bad') }
              }}>彻底删除</Btn>
            )}
          </div>
        )}
      />

      {readonly && p.closeoutSummary && (
        <Card title={`结束原因 / 复盘记录（${p.status === 'closed' ? '已结项' : '已取消'} · 只读）`}><div className="whitespace-pre-wrap text-[13px]">{p.closeoutSummary}</div></Card>
      )}

      {/* S42（v0.44）：进度（堆叠条/完成率）与排期（任务级甘特+里程碑刻度）一屏总览；v0.49 起交付日期入轴（S42-5）。
          S57（v0.62）：进度与甘特只认工作类——纯提醒送达不算工作完成度（与 brief/metrics 口径一致，K40）。
          S69（v0.80，K64）：常态项目以周视图二维表代替——甘特对无期限项目无意义。 */}
      {routine
        ? <DailyWeekGrid projectId={id} defaultSpan={p.boardSpan ?? 'week'} readonly={readonly} onChanged={() => void refresh()} />
        : <ProgressSchedule tasks={p.tasks.filter((t) => t.kind !== 'reminder')} milestones={p.milestones} projectEndDate={p.planEndDate} />}

      <Card title={`02 · 任务面（${p.tasks.length}）${readonly ? ' · 只读' : ''}`} actions={!readonly ? (
        <div className="flex gap-2">
          {/* S39：AI 初始分配——按类型初始化提示词批量产「责任人+排期」草案，人审后一键应用（交付项目专用，常态任务无排期语义） */}
          {!routine && p.tasks.some((t) => t.status !== 'done') && (
            <Btn small onClick={() => setInitAssigning(true)} title="按类型初始化提示词批量分配责任人与计划起止（草案可改，应用后生效）"><Sparkles aria-hidden="true" size={13} />AI 初始分配</Btn>
          )}
          <Btn small onClick={() => void 0} title="底部添加行">在下方添加</Btn>
        </div>
      ) : undefined}>
        {p.tasks.length === 0 ? <Empty hint={routine ? '暂无常态任务（每行一条，选适用星期，按周打卡）' : '暂无任务（自由创建项目可手工添加）'} /> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[44rem] text-[13px]">
              <thead className="text-left text-[10px] font-medium tracking-[0.07em] text-[var(--color-ink-soft)]">
                <tr className="border-b border-[var(--color-line)] [&>th]:whitespace-nowrap [&>th]:px-3 [&>th]:py-3">
                  {routine
                    ? <>任务<th>责任人（唯一）</th><th>适用星期</th><th>备注</th><th>标记</th><th></th></>
                    : <>任务<th>责任人（唯一）</th><th>状态</th><th>计划开始</th><th>计划结束</th><th>备注</th><th>标记</th><th></th></>}
                </tr>
              </thead>
              <tbody>
                {p.tasks.map((t) => {
                  // S41/K23：整行浅底色按视觉桶区分（逾期红优先于状态色），data-visual 为冒烟锚点
                  const visual = taskVisual(t)
                  const statusTone = TASK_STATUS_TONE[t.status] || 'muted'
                  return (
                  <tr key={t.id} data-testid="task-row" data-visual={visual} className={`border-b border-[var(--color-line)] last:border-0 [&>td]:px-3 [&>td]:py-3 ${TASK_ROW_CLS[visual]}`}>
                    <td className={`${t.status === 'done' ? 'text-[var(--color-ink-soft)]' : ''}`}>
                      {/* S2-4（v0.48）：标题旁展示稳定编号 #id——群内/任意渠道按编号锁定唯一任务（与机器人盘点/事件留痕同口径）；编号只读，不进标题编辑态 */}
                      <span className="num mr-1.5 text-[12px] text-[var(--color-ink-soft)]">#{t.id}</span>
                      {readonly ? t.title : (
                        <InlineText value={t.title} className={t.status === 'done' ? 'text-[var(--color-ink-soft)]' : undefined} onSubmit={async (v) => { await api.patchTask(t.id, { title: v }); await refresh() }} />
                      )}
                    </td>
                    <td>
                      {readonly ? nameOf(t.responsibleMemberId) : (
                        <select className="cursor-pointer rounded bg-transparent px-1 py-0.5 hover:bg-[var(--color-brand-soft)]"
                          value={t.responsibleMemberId ?? ''} onChange={async (e) => { await api.patchTask(t.id, { responsibleMemberId: e.target.value === '' ? '' : Number(e.target.value) }); toast('责任人变更已留痕'); await refresh() }}>
                          <option value="">（未指派）</option>
                          {activeMembers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                        </select>
                      )}
                    </td>
                    {routine ? (
                      <>
                        {/* S69：适用星期（勾选改，≥1 天；行=模板，每日执行走周视图打卡） */}
                        <td>
                          {readonly ? (t.weekdays?.length === 7 || !t.weekdays ? '每天' : `每周${t.weekdays.map((d) => '一二三四五六日'[d - 1]).join('、')}`) : (
                            <WeekdayPicker
                              value={t.weekdays?.length ? t.weekdays : [1, 2, 3, 4, 5, 6, 7]}
                              onChange={async (v) => { try { await api.patchTask(t.id, { weekdays: v }); toast('适用星期已更新'); await refresh() } catch (e) { toast((e as Error).message, 'bad') } }} />
                          )}
                        </td>
                        <td className="max-w-[10rem]">
                          {readonly ? <span className="block truncate" title={t.note || ''}>{t.note || '—'}</span> : (
                            <InlineText value={t.note} placeholder="点此补备注" className="block max-w-[10rem] truncate"
                              onSubmit={async (v) => { await api.patchTask(t.id, { note: v }); await refresh() }} />
                          )}
                        </td>
                        <td>
                          <Badge tone="info" data-testid="routine-badge">🔁 常态</Badge>
                          {!!t.refCount && <Badge tone="info">参考 {t.refCount}</Badge>}
                        </td>
                      </>
                    ) : (
                      <>
                        <td>
                          {readonly ? (
                            <Badge tone={statusTone} data-testid="task-status-badge" data-tone={statusTone}>{TASK_STATUS_LABEL[t.status] || t.status}</Badge>
                          ) : (
                            <InlineSelect value={t.status} options={TASK_STATUS_LABEL} tones={TASK_STATUS_TONE} onSubmit={async (v) => { await api.patchTask(t.id, { status: v }); await refresh() }} />
                          )}
                        </td>
                        <td className="num">{readonly ? (t.planStartDate || '—') : <InlineText type="date" value={t.planStartDate} onSubmit={async (v) => { await api.patchTask(t.id, { planStartDate: v }); await refresh() }} />}</td>
                        <td className={`num ${t.isOverdue ? 'text-[var(--color-bad)]' : ''}`}>{readonly ? (t.planEndDate || '—') : <InlineText type="date" value={t.planEndDate} onSubmit={async (v) => { await api.patchTask(t.id, { planEndDate: v }); await refresh() }} />}</td>
                        <td className="max-w-[10rem]">
                          {/* S58：任务备注（≤200 字）——模板默认值立项拷贝，实例独立改；提醒/预警推送自动携带 */}
                          {readonly ? <span className="block truncate" title={t.note || ''}>{t.note || '—'}</span> : (
                            <InlineText value={t.note} placeholder="点此补备注" className="block max-w-[10rem] truncate"
                              onSubmit={async (v) => { await api.patchTask(t.id, { note: v }); await refresh() }} />
                          )}
                        </td>
                        <td>
                          {t.isOverdue && <Badge tone="bad">逾期</Badge>}
                          {t.kind === 'reminder' && <Badge tone="info" data-testid="reminder-badge">⏰ 提醒</Badge>}
                          {t.kind === 'reminder' && t.remindedAt && <Badge tone="ok">已送达</Badge>}
                          {!!t.refCount && <Badge tone="info">参考 {t.refCount}</Badge>}
                        </td>
                      </>
                    )}
                    <td className="whitespace-nowrap">
                      <Btn small kind="ghost" onClick={() => setRefsTask({ id: t.id, title: t.title })}>参考</Btn>
                      <Btn small kind="ghost" onClick={() => setRecordsTaskId(t.id)}>记录</Btn>
                      {!readonly && (
                        <Btn small kind="ghost" onClick={async () => {
                          if (!confirm(`删除任务「${t.title}」？软删留痕：任务从列表与指标中移除，参考链接一并移除；更新记录与历史事件保留。`)) return
                          try {
                            await api.deleteTask(t.id)
                            toast('任务已删除（软删留痕）'); await refresh()
                          } catch (e) { toast((e as Error).message, 'bad') }
                        }}>删除</Btn>
                      )}
                    </td>
                  </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        {!readonly && <AddTask projectId={id} members={activeMembers} routine={routine} onDone={refresh} />}
      </Card>

      <section>
        <SectionHeading index="03" title="项目资产" />
        <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
        <Card title={`里程碑（${p.milestones.length}）`}>
          {p.milestones.length === 0 ? <Empty hint="暂无里程碑" /> : (
            <ul className="space-y-1 text-[13px]">
              {p.milestones.map((m) => (
                <li key={m.id} className="flex items-center justify-between border-b border-[var(--color-line)] py-1 last:border-0">
                  <span>{m.name}</span>
                  <span className="num flex items-center gap-2">
                    {readonly ? (m.planDate || '—') : <InlineText type="date" value={m.planDate} onSubmit={async (v) => { await api.patchMilestone(m.id, { planDate: v }); await refresh() }} />}
                    {readonly ? (
                      <Badge tone={MILESTONE_STATUS_TONE[m.status] || 'muted'} data-testid="milestone-status-badge">{MILESTONE_STATUS_LABEL[m.status] || m.status}</Badge>
                    ) : (
                      <InlineSelect value={m.status} options={MILESTONE_STATUS_LABEL} tones={MILESTONE_STATUS_TONE} onSubmit={async (v) => { await api.patchMilestone(m.id, { status: v }); toast('里程碑状态已更新'); await refresh() }} />
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {!readonly && <AddMilestone projectId={id} onDone={refresh} />}
        </Card>

        <Card title={`核心渠道（${channels.length}）`} actions={canManageChannels ? <Btn small onClick={() => setBinding(true)}>绑定渠道</Btn> : undefined}>
          {channels.length === 0 ? <Empty hint="未绑定专题渠道（计入管理员待办）" /> : (
            <ul className="space-y-1 text-[13px]">
              {channels.map((c) => (
                <li key={c.id} className="flex items-center justify-between border-b border-[var(--color-line)] py-1 last:border-0">
                  <span><Badge tone="info">{c.platform === 'feishu' ? '飞书' : '企微'}</Badge> <span className="num">{c.groupKey}</span> {c.name}</span>
                  {canManageChannels && <Btn small kind="ghost" onClick={async () => { await api.deleteChannel(c.id); toast('已解绑'); await refresh() }}>解绑</Btn>}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="知识库（飞书）" actions={
          <span className="flex items-center gap-2">
            {/* S63：手动触发全量汇总归档（绑定页面后可用；running 中防重入）；S72：常态项目关闭（K68） */}
            {wiki && canArchiveWiki && !routine && (
              <Btn small kind="primary" disabled={archiveRun?.status === 'running'} onClick={startArchive}>
                {archiveRun?.status === 'running' ? '生成中…' : '生成项目汇总'}
              </Btn>
            )}
            {canManageChannels ? <Btn small onClick={() => setBindingWiki(true)}>{wiki ? '换绑' : '绑定'}</Btn> : undefined}
          </span>
        }>
          {wiki ? (
            <div className="text-[13px]">
              <div className="flex items-center justify-between">
                <span>📄 《{wiki.title || '未命名'}》<span className="num text-[var(--color-ink-soft)]"> · {wiki.nodeToken}</span></span>
                <a className="text-[var(--color-primary)]" href={`https://feishu.cn/wiki/${wiki.nodeToken}`} target="_blank" rel="noreferrer">打开</a>
              </div>
              {archiveRun && (
                <div className="mt-1 text-[11px] text-[var(--color-ink-soft)]">
                  {archiveRun.status === 'running' && `⏳ 正在生成项目汇总：${ARCHIVE_STAGE_LABEL[archiveRun.stage ?? ''] ?? '处理中'}…`}
                  {archiveRun.status === 'done' && (
                    <span>
                      ✅ 最近汇总 {fmtDateTime(archiveRun.finishedAt ?? archiveRun.createdAt)} · 消息 {archiveRun.messageCount ?? 0} 条 · 金句 {archiveRun.quotesCount ?? 0} 条 · 图片 {archiveRun.imageCount ?? 0} 张 · 附件 {archiveRun.fileCount ?? 0} 个{archiveRun.truncated ? '（超上限已截断）' : ''}
                      {archiveRun.pageUrl && <> · <a className="text-[var(--color-primary)]" href={archiveRun.pageUrl} target="_blank" rel="noreferrer">查看</a></>}
                    </span>
                  )}
                  {archiveRun.status === 'failed' && `❌ 上次生成失败：${archiveRun.error ?? '未知错误'}`}
                </div>
              )}
            </div>
          ) : <Empty hint="未绑定知识库页面——绑定后在群里说「记一下…」即可写入" />}
        </Card>
        </div>
      </section>

      <Card title={`04 · 讨论面 · 事件流（${events.length}，append-only）`}>
        {/* S4-7（v0.46/K25）：多条待确认建议时提供一键批量处理——同口子逐条应用，聚合回执 */}
        {pendingSuggestions.length >= 2 && (
          <div className="mb-3 flex items-center gap-2 rounded-md border border-[var(--color-line)] bg-[var(--color-panel)] p-2 text-[12px]">
            <span className="text-[var(--color-ink-soft)]">待确认建议 {pendingSuggestions.length} 条</span>
            <Btn small kind="primary" onClick={() => void batchDecide('confirm')}>全部生效</Btn>
            <Btn small onClick={() => void batchDecide('reject')}>全部驳回</Btn>
          </div>
        )}
        {events.length === 0 ? <Empty hint="暂无事件：绑定渠道后由大脑自动抽取，或手动添加" /> : (
          <div className="grid gap-6 md:grid-cols-2 2xl:grid-cols-4">
            {EVENT_PINNED_COLS.map((col) => (
              <EventColumn
                key={col.key} title={col.title} testid={`event-col-${col.key}`}
                events={events.filter((e) => col.types.includes(e.eventType))}
                emptyHint={{ progress: '暂无进展', risk: '暂无风险/阻塞', finance: '暂无财务记录' }[col.key] ?? '暂无事件'}
                renderItem={renderEvent} />
            ))}
            <EventColumn
              title="其他" testid="event-col-other" events={shownOther}
              emptyHint={otherEvents.length ? '筛选已隐藏全部其他事件' : '暂无其他事件'}
              toolbar={(
                <div className="flex flex-wrap gap-1 border-b border-[var(--color-line)] px-2 py-1.5" aria-label="其他栏类型筛选器">
                  {otherTypes.map((t) => {
                    const shown = !hiddenEventTypes.includes(t)
                    return (
                      <button
                        key={t} type="button" aria-pressed={shown}
                        onClick={() => setHiddenEventTypes((cur) => (shown ? [...cur, t] : cur.filter((x) => x !== t)))}
                        className={`rounded border px-1.5 py-0.5 text-[11px] ${
                          shown
                            ? 'border-[var(--color-brand)] bg-[var(--color-brand-soft)] text-[var(--color-brand)]'
                            : 'border-[var(--color-line)] text-[var(--color-ink-soft)] opacity-60'
                        }`}>
                        {EVENT_TYPE_LABEL[t] || t}
                      </button>
                    )
                  })}
                </div>
              )}
              renderItem={renderEvent} />
          </div>
        )}
        {!readonly && <AddEvent projectId={id} onDone={refresh} />}
      </Card>

      {recordsTaskId !== null && (
        <TaskRecordsModal taskId={recordsTaskId} readonly={readonly} onClose={() => setRecordsTaskId(null)} />
      )}
      {refsTask !== null && (
        <TaskRefsModal taskId={refsTask.id} taskTitle={refsTask.title} readonly={readonly} onClose={() => setRefsTask(null)} />
      )}
      {closing && <CloseModal p={p} onClose={() => setClosing(false)} onDone={async () => { setClosing(false); toast('项目已结项归档'); await refresh() }} />}
      {cancelling && <CancelModal p={p} onClose={() => setCancelling(false)} onDone={async () => { setCancelling(false); toast('项目已取消归档'); await refresh() }} />}
      {binding && <BindChannelModal projectId={id} onClose={() => setBinding(false)} onDone={async () => { setBinding(false); toast('渠道已绑定'); await refresh() }} />}
      {bindingWiki && <BindWikiModal projectId={id} onClose={() => setBindingWiki(false)} onDone={async () => { setBindingWiki(false); toast('知识库已绑定'); await refresh() }} />}
      {initAssigning && (
        <InitAssignModal projectId={id} projectInitExtra={p.initExtra ?? ''} members={activeMembers} onClose={() => setInitAssigning(false)} onDone={async () => { setInitAssigning(false); await refresh() }} />
      )}
      {digesting && (
        <Modal title="🧠 项目梳理（S15）" onClose={() => setDigesting(false)} wide>
          <DigestBody fn={() => api.projectDigest(id)} />
        </Modal>
      )}
    </div>
  )
}

/** S4-8（v0.47）：讨论面分栏栏位——栏头（名称+计数）+ 可滚动时序列表；toolbar 槽给其他栏放类型筛选器。 */
function EventColumn({ title, testid, events, emptyHint, toolbar, renderItem }: {
  title: string; testid: string; events: EventRow[]; emptyHint: string
  toolbar?: ReactNode; renderItem: (e: EventRow) => ReactNode
}) {
  return (
    <section data-testid={testid} className="flex flex-col border-t border-[var(--color-ink)] pt-1">
      <header className="flex items-center gap-2 py-2.5 text-[12px] font-semibold">
        {title}
        <Badge tone="muted">{events.length}</Badge>
      </header>
      {toolbar}
      {events.length === 0 ? <Empty hint={emptyHint} /> : (
        <ul className="max-h-[28rem] space-y-0 overflow-y-auto pr-2">{events.map(renderItem)}</ul>
      )}
    </section>
  )
}

function DigestBody({ fn }: { fn: () => Promise<Record<string, unknown>> }) {  const [out, setOut] = useState<Record<string, unknown> | null>(null)
  const [err, setErr] = useState('')
  // eslint-disable-next-line react-hooks/exhaustive-deps -- 刻意仅挂载时执行一次：fn 由父组件内联新建，加入依赖会在每次父渲染时重跑梳理（多烧 LLM 调用）
  useEffect(() => { fn().then(setOut).catch((e) => setErr((e as Error).message)) }, [])
  if (err) return <div className="rounded bg-red-50 px-2 py-1.5 text-[13px] text-[var(--color-bad)]">{err}</div>
  if (!out) return <div className="py-6 text-center text-[var(--color-ink-soft)]">大脑梳理中…</div>
  return (
    <div className="space-y-2 text-[13px]">
      <div className="whitespace-pre-wrap">{String(out.narrative || out.title || JSON.stringify(out, null, 2))}</div>
      <div className="text-[12px] text-[var(--color-ink-soft)]">
        任务 {String(out.taskCount)} 项 · 逾期 {String(out.overdueCount)} · 未指派 {String(out.unassignedCount)} · 近期事件 {String(out.eventCount)} 条 · 建议 {Array.isArray(out.suggestions) ? out.suggestions.length : 0} 条（待确认）
      </div>
    </div>
  )
}

function TaskRecordsModal({ taskId, readonly, onClose }: { taskId: number; readonly: boolean; onClose: () => void }) {
  const { toast } = useStore()
  const [records, setRecords] = useState<TaskRecordRow[] | null>(null)
  const [draft, setDraft] = useState('')
  const refresh = useCallback(async () => { const r = await api.taskRecords(taskId); setRecords(r.records) }, [taskId])
  useEffect(() => { void refresh() }, [refresh])
  return (
    <Modal title={`任务更新记录（S2-3，追加式 · ${records?.length ?? 0} 条）`} onClose={onClose}>
      {!records ? <Spinner /> : records.length === 0 ? <Empty hint="暂无记录，追加第一条更新" /> : (
        <ul className="mb-3 max-h-72 space-y-2 overflow-auto">
          {records.map((r) => (
            <li key={r.id} className="rounded-md border border-[var(--color-line)] p-2 text-[13px]">
              <div className="mb-0.5 text-[11px] text-[var(--color-ink-soft)]">
                <span className="num">{fmtDateTime(r.createdAt)}</span> · {r.memberName || '系统'}
              </div>
              <div className="whitespace-pre-wrap">{r.content}</div>
            </li>
          ))}
        </ul>
      )}
      {!readonly && (
        <div className="flex gap-2">
          <input
            className={inputCls} placeholder="追加一条更新记录（Enter 保存，只增不改）" value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={async (e) => {
              if (e.key === 'Enter' && draft.trim()) {
                try { await api.addTaskRecord(taskId, draft); setDraft(''); toast('记录已追加'); await refresh() } catch (e2) { toast((e2 as Error).message, 'bad') }
              }
            }} />
        </div>
      )}
      {readonly && <div className="text-[11px] text-[var(--color-ink-soft)]">项目已归档，记录只读。</div>}
    </Modal>
  )
}

/** S23 任务参考资料：SOP/知识库链接的查看与手工维护（软删；结项只读）；推送会附带给执行人。 */
function TaskRefsModal({ taskId, taskTitle, readonly, onClose }: { taskId: number; taskTitle: string; readonly: boolean; onClose: () => void }) {
  const { toast } = useStore()
  const [refs, setRefs] = useState<TaskRefRow[] | null>(null)
  const [title, setTitle] = useState('')
  const [url, setUrl] = useState('')
  const [note, setNote] = useState('')
  const [editing, setEditing] = useState<TaskRefRow | null>(null)
  const refresh = useCallback(async () => { const r = await api.taskRefs(taskId); setRefs(r.refs) }, [taskId])
  useEffect(() => { void refresh() }, [refresh])
  const add = async () => {
    try {
      await api.addTaskRef(taskId, { title: title.trim(), url: url.trim(), note: note.trim() || undefined })
      setTitle(''); setUrl(''); setNote(''); toast('参考资料已添加'); await refresh()
    } catch (e) { toast((e as Error).message, 'bad') }
  }
  const saveEdit = async () => {
    if (!editing) return
    try {
      await api.patchTaskRef(taskId, editing.id, { title: editing.title, url: editing.url, note: editing.note || '' })
      setEditing(null); toast('参考资料已更新'); await refresh()
    } catch (e) { toast((e as Error).message, 'bad') }
  }
  return (
    <Modal title={`任务参考资料（S23）· ${taskTitle}`} onClose={onClose}>
      {!refs ? <Spinner /> : refs.length === 0 ? <Empty hint="暂无参考资料（可挂 SOP / 知识库链接，推送时会附带给责任人）" /> : (
        <ul className="mb-3 max-h-72 space-y-2 overflow-auto">
          {refs.map((r) => (
            <li key={r.id} className="rounded-md border border-[var(--color-line)] p-2 text-[13px]">
              {editing?.id === r.id ? (
                <div className="space-y-1.5">
                  <input className={inputCls} placeholder="标题（如：部署 SOP）" value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} />
                  <input className={inputCls} placeholder="链接（https://…）" value={editing.url} onChange={(e) => setEditing({ ...editing, url: e.target.value })} />
                  <input className={inputCls} placeholder="备注（可选）" value={editing.note || ''} onChange={(e) => setEditing({ ...editing, note: e.target.value })} />
                  <div className="flex gap-2">
                    <Btn small kind="primary" disabled={!editing.title.trim() || !editing.url.trim()} onClick={() => void saveEdit()}>保存</Btn>
                    <Btn small onClick={() => setEditing(null)}>取消</Btn>
                  </div>
                </div>
              ) : (
                <>
                  <a className="font-medium text-[var(--color-brand)] hover:underline" href={r.url} target="_blank" rel="noreferrer">{r.title}</a>
                  <span className="num ml-2 break-all text-[11px] text-[var(--color-ink-soft)]">{r.url}</span>
                  {r.note && <div className="mt-0.5 text-[12px] text-[var(--color-ink-soft)]">{r.note}</div>}
                  <div className="mt-1 flex items-center gap-2 text-[11px] text-[var(--color-ink-soft)]">
                    <span className="num">{fmtDateTime(r.createdAt)}</span>
                    {r.createdByName && <span>· {r.createdByName}</span>}
                    {!readonly && (
                      <span className="ml-auto flex gap-1">
                        <Btn small kind="ghost" onClick={() => setEditing({ ...r })}>编辑</Btn>
                        <Btn small kind="ghost" onClick={async () => {
                          try { await api.deleteTaskRef(taskId, r.id); toast('已移除（软删留痕）'); await refresh() } catch (e) { toast((e as Error).message, 'bad') }
                        }}>移除</Btn>
                      </span>
                    )}
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {!readonly && (
        <div className="space-y-1.5">
          <div className="flex gap-2">
            <input className={inputCls} placeholder="标题（如：部署 SOP）" value={title} onChange={(e) => setTitle(e.target.value)} />
            <input className={inputCls} placeholder="链接（https://…）" value={url} onChange={(e) => setUrl(e.target.value)} />
          </div>
          <div className="flex gap-2">
            <input className={inputCls} placeholder="备注（可选：适用时机/范围）" value={note} onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && title.trim() && url.trim()) void add() }} />
            <Btn small kind="primary" disabled={!title.trim() || !url.trim()} onClick={() => void add()}>添加</Btn>
          </div>
        </div>
      )}
      {readonly && <div className="text-[11px] text-[var(--color-ink-soft)]">项目已归档，参考资料只读。</div>}
    </Modal>
  )
}

function AddTask({ projectId, members, routine, onDone }: { projectId: number; members: Member[]; routine?: boolean; onDone: () => Promise<void> }) {
  const [title, setTitle] = useState('')
  const [note, setNote] = useState('') // S58：任务备注（可选，≤200 字；提醒/预警推送自动携带）
  const [owner, setOwner] = useState('') // S38：新建默认未指派（责任人与项目牵头人解耦，K20）
  const [kind, setKind] = useState('work') // S57：work=工作 / reminder=纯提醒（到期推送后自动完成）
  const [date, setDate] = useState('') // S57：纯提醒的提醒日（=planEndDate，必填）
  const [weekdays, setWeekdays] = useState<number[]>([1, 2, 3, 4, 5, 6, 7]) // S69：常态任务适用星期（缺省每天）
  const submit = async () => {
    if (!title.trim()) return
    if (kind === 'reminder' && !date) return
    await api.createTask({
      projectId, title, kind: routine ? 'routine' : kind,
      ...(routine ? { weekdays } : {}),
      ...(kind === 'reminder' && !routine ? { planEndDate: date } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
      ...(owner ? { responsibleMemberId: Number(owner) } : {}),
    })
    setTitle(''); setNote(''); setOwner(''); setDate(''); await onDone()
  }
  const reminder = !routine && kind === 'reminder'
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {!routine && (
        <select className="cell-input w-full sm:w-28" aria-label="新任务分类" value={kind}
          onChange={(e) => setKind(e.target.value)}>
          <option value="work">工作</option>
          <option value="reminder">⏰ 纯提醒</option>
        </select>
      )}
      {routine && (
        <span className="flex items-center gap-1.5" aria-label="适用星期">
          <WeekdayPicker value={weekdays} onChange={setWeekdays} />
        </span>
      )}
      <input className="cell-input min-w-[12rem] flex-1"
        placeholder={routine ? '新增常态任务标题（选适用星期，按周打卡，Enter 保存）' : reminder ? '新增提醒标题（提醒日推责任人+项目群后自动完成）' : '新增任务标题（默认未指派，Enter 保存）'}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') void submit() }} />
      {reminder && (
        <input type="date" className="cell-input w-full sm:w-40" aria-label="提醒日（必填）" value={date}
          onChange={(e) => setDate(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void submit() }} />
      )}
      <input className="cell-input w-full sm:w-44" aria-label="新任务备注（可选）" placeholder="备注：怎么干（可选）"
        maxLength={200} value={note} onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') void submit() }} />
      <select className="cell-input w-full sm:w-32" aria-label="新任务责任人（默认未指派）" value={owner} onChange={(e) => setOwner(e.target.value)}>
        <option value="">（未指派）</option>
        {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
      </select>
    </div>
  )
}

/** S39（v0.42）+ S44（v0.45 异步化）+ S64（v0.69 三层要求）：AI 初始分配弹窗——先确认要求
 * （项目补充要求=长期存本项目；本次追加要求=仅本次）再启动，启动后 2s 轮询作业（GLM 可能要 1~2 分钟），
 * 草案（不落库）逐行可编辑，「应用」单事务批量生效并留痕。 */
function InitAssignModal({ projectId, projectInitExtra, members, onClose, onDone }: { projectId: number; projectInitExtra: string; members: Member[]; onClose: () => void; onDone: () => Promise<void> }) {
  const { toast } = useStore()
  const [phase, setPhase] = useState<'config' | 'running'>('config')
  const [projectExtra, setProjectExtra] = useState(projectInitExtra)
  const [runExtra, setRunExtra] = useState('')
  const [rows, setRows] = useState<InitAssignmentRow[] | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])
  const [err, setErr] = useState('')
  const [waitSec, setWaitSec] = useState(0)
  const [applying, setApplying] = useState(false)
  const start = async () => {
    setErr('')
    try {
      // S64：项目补充要求改动随启动保存到项目（PATCH，空串归一 NULL）；本次追加要求只随本次草案提交
      if (projectExtra.trim() !== projectInitExtra.trim()) {
        await api.patchProject(projectId, { initExtra: projectExtra.trim() })
      }
      setPhase('running')
    } catch (e) { setErr((e as Error).message) }
  }
  useEffect(() => {
    if (phase !== 'running') return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const t0 = Date.now()
    void (async () => {
      try {
        const start = await api.draftInitAssignments(projectId, runExtra.trim() || undefined) // 202 {draftId, status:'running'}
        const poll = async () => {
          if (stopped) return
          try {
            const out = await api.getDraftInitAssignment(projectId, start.draftId)
            if (stopped) return
            if (out.status === 'running') {
              setWaitSec(Math.round((Date.now() - t0) / 1000))
              timer = setTimeout(() => void poll(), 2000)
              return
            }
            if (out.status === 'error') { setErr(out.message || '草案生成失败'); return }
            setRows(out.assignments ?? []); setWarnings(out.warnings ?? [])
          } catch (e) { if (!stopped) setErr((e as Error).message) }
        }
        await poll()
      } catch (e) { if (!stopped) setErr((e as Error).message) }
    })()
    return () => { stopped = true; if (timer) clearTimeout(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 刻意仅进入 running 时启动一次：runExtra 是启动时刻的快照，加入依赖会在运行中输入变化时重启草案（多烧 LLM）
  }, [projectId, phase])
  const patchRow = (taskId: number, p: Partial<InitAssignmentRow>) =>
    setRows((rs) => (rs ?? []).map((r) => (r.taskId === taskId ? { ...r, ...p } : r)))
  const apply = async () => {
    if (!rows?.length) return
    setApplying(true); setErr('')
    try {
      const out = await api.applyInitAssignments(projectId, rows.map((r) => ({
        taskId: r.taskId, responsibleMemberId: r.responsibleMemberId, planStartDate: r.planStartDate, planEndDate: r.planEndDate,
      })))
      toast(`初始分配已应用：${out.updated} 项任务（已留痕）`)
      await onDone()
    } catch (e) { setErr((e as Error).message); setApplying(false) }
  }
  return (
    <Modal title="✨ AI 初始分配（S39）" onClose={onClose} wide>
      {err && <div className="mb-3 rounded bg-red-50 px-2 py-1.5 text-[12px] text-[var(--color-bad)]">{err}</div>}
      {phase === 'config' && (
        <div className="flex flex-col gap-3">
          <div className="rounded-md border border-[var(--color-line)] px-2.5 py-2 text-[12px] leading-5 text-[var(--color-ink-soft)]">
            草案按三层要求生成：<b>类型初始化提示词</b> → <b>项目补充要求</b> → <b>本次追加要求</b>（未填的层自动跳过）。
            草案不落库，生成后逐行可编辑再应用；也可在项目群 @机器人 触发（确认卡点按生效，S64）。
          </div>
          <label className="flex flex-col gap-1 text-[12px]">
            <span className="font-medium">项目补充要求（保存到本项目，之后每次初始分配都带上）</span>
            <textarea className="cell-input" rows={3} value={projectExtra} onChange={(e) => setProjectExtra(e.target.value)}
              placeholder="如：这期张三牵头，大部分开发任务给李四，11 月中前收口" />
          </label>
          <label className="flex flex-col gap-1 text-[12px]">
            <span className="font-medium">本次追加要求（仅本次生效，不保存）</span>
            <textarea className="cell-input" rows={2} value={runExtra} onChange={(e) => setRunExtra(e.target.value)}
              placeholder="如：验收前留两天缓冲" />
          </label>
          <div className="flex items-center justify-end gap-2">
            <Btn onClick={onClose}>取消</Btn>
            <Btn kind="primary" onClick={() => void start()}>开始生成草案</Btn>
          </div>
        </div>
      )}
      {!rows && !err && phase === 'running' && (
        <div className="py-6 text-center text-[var(--color-ink-soft)]" data-testid="init-assign-waiting">
          大脑分配中（已等待 {waitSec}s；GLM 大输出可能要 1~2 分钟）…
        </div>
      )}
      {rows && (
        <>
          {warnings.length > 0 && (
            <div className="mb-2 rounded-md border border-[var(--color-line)] px-2.5 py-2 text-[12px] text-[var(--color-ink-soft)]">
              {warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] text-[13px]">
              <thead className="text-left text-[12px] text-[var(--color-ink-soft)]">
                <tr className="border-b border-[var(--color-line)]"><th className="py-1.5">任务</th><th>责任人</th><th>计划开始</th><th>计划结束</th></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.taskId} className="border-b border-[var(--color-line)] last:border-0">
                    <td className="py-1 pr-2">{r.title}</td>
                    <td>
                      <select className="cursor-pointer rounded bg-transparent px-1 py-0.5 hover:bg-[var(--color-brand-soft)]"
                        aria-label={`任务 ${r.title} 责任人`}
                        value={r.responsibleMemberId ?? ''}
                        onChange={(e) => patchRow(r.taskId, { responsibleMemberId: e.target.value === '' ? null : Number(e.target.value) })}>
                        <option value="">（未指派）</option>
                        {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                      </select>
                    </td>
                    <td><input type="date" className="cell-input !w-36" value={r.planStartDate ?? ''} onChange={(e) => patchRow(r.taskId, { planStartDate: e.target.value || null })} /></td>
                    <td><input type="date" className="cell-input !w-36" value={r.planEndDate ?? ''} onChange={(e) => patchRow(r.taskId, { planEndDate: e.target.value || null })} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3 flex items-center justify-end gap-2">
            <span className="mr-auto text-[11px] text-[var(--color-ink-soft)]">草案由 AI 按类型初始化提示词生成（未落库）；应用后单事务生效，讨论面与审计留痕。</span>
            <Btn onClick={onClose}>取消</Btn>
            <Btn kind="primary" disabled={applying || rows.length === 0} onClick={() => void apply()}>{applying ? '应用中…' : `应用 ${rows.length} 项`}</Btn>
          </div>
        </>
      )}
    </Modal>
  )
}

function AddMilestone({ projectId, onDone }: { projectId: number; onDone: () => Promise<void> }) {
  const [name, setName] = useState('')
  const [date, setDate] = useState('')
  return (
    <div className="mt-3 flex flex-col gap-2 sm:flex-row">
      <input className="cell-input" placeholder="里程碑名" value={name} onChange={(e) => setName(e.target.value)} />
      <input type="date" className="cell-input w-full sm:w-40" value={date} onChange={(e) => setDate(e.target.value)} />
      <Btn small disabled={!name} onClick={async () => { await api.createMilestone({ projectId, name, planDate: date }); setName(''); setDate(''); await onDone() }}>添加</Btn>
    </div>
  )
}

function AddEvent({ projectId, onDone }: { projectId: number; onDone: () => Promise<void> }) {
  const [summary, setSummary] = useState('')
  const [type, setType] = useState('progress')
  return (
    <div className="mt-3 flex flex-col gap-2 sm:flex-row">
      <select className="cell-input w-full sm:w-28" value={type} onChange={(e) => setType(e.target.value)}>
        {Object.entries(EVENT_TYPE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
      <input className="cell-input" placeholder="手动补充讨论面记录（记录型，Enter 保存）" value={summary}
        onChange={(e) => setSummary(e.target.value)}
        onKeyDown={async (e) => {
          if (e.key === 'Enter' && summary.trim()) { await api.addProjectEvent(projectId, { eventType: type, summary, nature: 'record' }); setSummary(''); await onDone() }
        }} />
    </div>
  )
}

function CloseModal({ p, onClose, onDone }: { p: ProjectDetail; onClose: () => void; onDone: () => Promise<void> }) {
  const routine = p.kind === 'routine' // S69：常态项目结项豁免「全部任务完成」（手动结项即可）
  const [unfinished, setUnfinished] = useState(() => (routine ? [] : p.tasks.filter((t) => t.status !== 'done')))
  const [summary, setSummary] = useState('')
  const [err, setErr] = useState('')
  const [drafting, setDrafting] = useState(false)
  const markDone = async (taskId: number) => {
    await api.patchTask(taskId, { status: 'done' })
    setUnfinished((list) => list.filter((t) => t.id !== taskId))
  }
  const markAll = async () => {
    for (const t of unfinished) await api.patchTask(t.id, { status: 'done' })
    setUnfinished([])
  }
  const aiDraft = async () => {
    setDrafting(true); setErr('')
    try {
      const out = await api.closeoutDraft(p.id)
      setSummary(out.summary) // AI 草稿仅预填，人工改后提交（S8-2/S29：最终文本人拍板）
    } catch (e) { setErr((e as Error).message) } finally { setDrafting(false) }
  }
  const submit = async () => {
    try {
      await api.closeProject(p.id, { summary: summary.trim() })
      await onDone()
    } catch (e) { setErr((e as Error).message) }
  }
  return (
    <Modal title={routine
      ? '结项（S8）：常态项目手动结项，豁免「全部任务完成」（S69）；结项总结必填（S29）'
      : '结项（S8）：所有任务标记完成后方可结项；结项总结必填（S29）'} onClose={onClose} wide>
      {routine ? (
        <div className="mb-3 text-[13px] text-[var(--color-ink-soft)]" data-testid="routine-close-note">
          常态项目无「全部任务完成」要求——任务行是每日打卡模板，直接结项即可；结项后周视图与任务面转只读，历史打卡记录保留可查。
        </div>
      ) : unfinished.length === 0 ? <div className="mb-3 text-[13px] text-[var(--color-ink-soft)]">无未完任务，可直接结项。</div> : (
        <div className="mb-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[13px]">未完任务 {unfinished.length} 项（v0.6：唯一终态=完成，无「取消」处置）</span>
            <Btn small kind="primary" onClick={() => void markAll()}>全部标记完成</Btn>
          </div>
          <table className="w-full text-[13px]">
            <thead className="text-left text-[12px] text-[var(--color-ink-soft)]"><tr className="border-b border-[var(--color-line)]"><th className="py-1">任务</th><th>状态</th><th></th></tr></thead>
            <tbody>
              {unfinished.map((t) => {
                const tone = TASK_STATUS_TONE[t.status] || 'muted'
                return (
                <tr key={t.id} data-testid="task-row" data-visual={taskVisual(t)} className={`border-b border-[var(--color-line)] last:border-0 ${TASK_ROW_CLS[taskVisual(t)]}`}>
                  <td className="py-1">{t.title}</td>
                  <td><Badge tone={tone} data-testid="task-status-badge" data-tone={tone}>{TASK_STATUS_LABEL[t.status] || t.status}</Badge></td>
                  <td><Btn small onClick={() => void markDone(t.id)}>标记完成</Btn></td>
                </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <Field label="结项总结 *（必填：结束项目必须留原因文本，S29）">
        <textarea className={inputCls} rows={4} value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="可点下方「AI 复盘草稿」基于事件流生成草稿，再人工修订" />
      </Field>
      <div className="mb-3">
        <Btn small disabled={drafting} onClick={() => void aiDraft()}>{drafting ? '生成中…' : '✨ AI 复盘草稿（预填可改）'}</Btn>
      </div>
      {err && <div className="mb-3 rounded bg-red-50 px-2 py-1.5 text-[12px] text-[var(--color-bad)]">{err}</div>}
      <div className="flex justify-end gap-2">
        <Btn onClick={onClose}>返回</Btn>
        <Btn kind="danger" disabled={!summary.trim()} onClick={submit}>确认结项</Btn>
      </div>
      {err === '' && <div className="mt-2 text-[11px] text-[var(--color-ink-soft)]">结项后项目与任务面转只读、终态不可逆，事件流保留。</div>}
    </Modal>
  )
}

/** S8-3/S29 取消项目：原因必填；未完任务原样冻结（无需处置）；终态不可逆。 */
function CancelModal({ p, onClose, onDone }: { p: ProjectDetail; onClose: () => void; onDone: () => Promise<void> }) {
  const [reason, setReason] = useState('')
  const [err, setErr] = useState('')
  const open = p.tasks.filter((t) => t.status !== 'done').length
  const submit = async () => {
    try {
      await api.cancelProject(p.id, { reason: reason.trim() })
      await onDone()
    } catch (e) { setErr((e as Error).message) }
  }
  return (
    <Modal title="取消项目（S8-3）：原因必填，取消后终态不可逆" onClose={onClose}>
      {open > 0 && (
        <div className="mb-3 rounded-md border border-[var(--color-line)] px-2.5 py-2 text-[12px] text-[var(--color-ink-soft)]">
          还有 {open} 项未完任务——取消不做处置、原样冻结（退出预警/日报/梳理口径），项目转只读归档。
        </div>
      )}
      <Field label="取消原因 *（必填：结束项目必须留原因文本，S29）">
        <textarea className={inputCls} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="如：客户战略调整，项目终止" />
      </Field>
      {err && <div className="mb-3 rounded bg-red-50 px-2 py-1.5 text-[12px] text-[var(--color-bad)]">{err}</div>}
      <div className="flex justify-end gap-2">
        <Btn onClick={onClose}>返回</Btn>
        <Btn kind="danger" disabled={!reason.trim()} onClick={submit}>确认取消项目</Btn>
      </div>
    </Modal>
  )
}

function BindChannelModal({ projectId, onClose, onDone }: { projectId: number; onClose: () => void; onDone: () => Promise<void> }) {
  const [platform, setPlatform] = useState('feishu')
  const [groupKey, setGroupKey] = useState('')
  const [name, setName] = useState('')
  const [err, setErr] = useState('')
  return (
    <Modal title="绑定核心渠道（S1-3）" onClose={onClose}>
      <Field label="平台">
        <select className={inputCls} value={platform} onChange={(e) => setPlatform(e.target.value)}>
          <option value="feishu">飞书</option><option value="wecom">企业微信</option>
        </select>
      </Field>
      <Field label="群标识（飞书 chat_id / 企微群 id）"><input className={inputCls} value={groupKey} onChange={(e) => setGroupKey(e.target.value)} /></Field>
      <Field label="群名称（可选）"><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} /></Field>
      {err && <div className="mb-3 rounded bg-red-50 px-2 py-1.5 text-[12px] text-[var(--color-bad)]">{err}</div>}
      <div className="flex justify-end gap-2">
        <Btn onClick={onClose}>取消</Btn>
        <Btn kind="primary" disabled={!groupKey} onClick={async () => {
          try { await api.upsertChannel({ platform, groupKey, name, channelType: 'dedicated', projectId }); await onDone() } catch (e) { setErr((e as Error).message) }
        }}>绑定</Btn>
      </div>
      <div className="mt-2 text-[11px] text-[var(--color-ink-soft)]">专题渠道 1 群:1 项目；跨项目混聊的通用群请在配置台维护。</div>
    </Modal>
  )
}

/** S61（v0.66）：绑定项目到飞书知识库页面——贴已有页面链接，或在指定页面下新建子页。 */
function BindWikiModal({ projectId, onClose, onDone }: { projectId: number; onClose: () => void; onDone: () => Promise<void> }) {
  const [mode, setMode] = useState<'existing' | 'create'>('existing')
  const [wikiUrl, setWikiUrl] = useState('')
  const [parentWikiUrl, setParentWikiUrl] = useState('')
  const [newTitle, setNewTitle] = useState('')
  const [err, setErr] = useState('')
  const canSubmit = mode === 'existing' ? Boolean(wikiUrl) : Boolean(parentWikiUrl && newTitle)
  return (
    <Modal title="绑定知识库页面（S61）" onClose={onClose}>
      <Field label="方式">
        <select className={inputCls} value={mode} onChange={(e) => setMode(e.target.value as 'existing' | 'create')}>
          <option value="existing">绑定已有页面</option><option value="create">在指定页面下新建子页</option>
        </select>
      </Field>
      {mode === 'existing' ? (
        <Field label="页面链接（https://xxx.feishu.cn/wiki/...）"><input className={inputCls} value={wikiUrl} onChange={(e) => setWikiUrl(e.target.value)} placeholder="粘贴 wiki 页面链接" /></Field>
      ) : (
        <>
          <Field label="父页面链接"><input className={inputCls} value={parentWikiUrl} onChange={(e) => setParentWikiUrl(e.target.value)} placeholder="在该页面下新建" /></Field>
          <Field label="子页标题"><input className={inputCls} value={newTitle} onChange={(e) => setNewTitle(e.target.value)} /></Field>
        </>
      )}
      {err && <div className="mb-3 rounded bg-red-50 px-2 py-1.5 text-[12px] text-[var(--color-bad)]">{err}</div>}
      <div className="flex justify-end gap-2">
        <Btn onClick={onClose}>取消</Btn>
        <Btn kind="primary" disabled={!canSubmit} onClick={async () => {
          try {
            await api.bindProjectWiki(projectId, mode === 'existing' ? { wikiUrl } : { parentWikiUrl, newTitle })
            await onDone()
          } catch (e) { setErr((e as Error).message) }
        }}>绑定</Btn>
      </div>
      <div className="mt-2 text-[11px] text-[var(--color-ink-soft)]">前提：知识库管理员已把机器人加进知识库（知识库设置→成员设置）。绑定后在项目群里说「记一下…」即可写入该页。</div>
    </Modal>
  )
}
