import { useEffect, useState } from 'react'
import { api } from '../api'
import { useStore } from '../store'
import { Badge, Btn, Card, Empty, Field, InlineSelect, InlineText, Modal, Spinner, inputCls } from '../components/ui'
import {
  EVENT_STATUS_LABEL, EVENT_TYPE_LABEL, PRIORITY_LABEL, PROJECT_STATUS_LABEL, TASK_STATUS_LABEL,
  type ChannelRow, type EventRow, type Member, type ProjectDetail,
} from '../types'

export default function ProjectDetail({ id }: { id: number }) {
  const { toast } = useStore()
  const [p, setP] = useState<ProjectDetail | null>(null)
  const [events, setEvents] = useState<EventRow[]>([])
  const [members, setMembers] = useState<Member[]>([])
  const [channels, setChannels] = useState<ChannelRow[]>([])
  const [closing, setClosing] = useState(false)
  const [binding, setBinding] = useState(false)
  const [digesting, setDigesting] = useState(false)

  const refresh = async () => {
    const [d, e, m, c] = await Promise.all([
      api.project(id), api.projectEvents(id), api.members(), api.channels(),
    ])
    setP(d); setEvents(e.events); setMembers(m.members); setChannels(c.channels.filter((ch) => ch.projectId === id))
  }
  useEffect(() => { void refresh() }, [id])

  if (!p) return <Spinner />
  const readonly = p.status === 'closed' || p.status === 'cancelled'
  const activeMembers = members.filter((m) => m.status === 'active')
  const nameOf = (mid: number | null | undefined) => activeMembers.find((m) => m.id === mid)?.name || '（未指派）'

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <a className="text-[13px] text-[var(--color-brand)] hover:underline" href="#/projects">← 项目列表</a>
        <h1 className="text-lg font-bold">{p.name}</h1>
        <InlineSelect value={p.priority} options={PRIORITY_LABEL} onSubmit={async (v) => { await api.patchProject(id, { priority: v }); toast('优先级已调整并留痕'); await refresh() }} />
        <InlineSelect value={p.status} options={PROJECT_STATUS_LABEL} onSubmit={async (v) => {
          try { await api.patchProject(id, { status: v }); toast('状态已更新'); await refresh() } catch (e) { toast((e as Error).message, 'bad') }
        }} />
        <span className="text-[12px] text-[var(--color-ink-soft)]">牵头人 {p.leadName}{p.clientName ? ` · 客户 ${p.clientName}` : ''}{readonly ? ' · 已归档只读' : ''}</span>
        <div className="ml-auto flex gap-2">
          <Btn onClick={async () => setDigesting(true)} disabled={digesting}>🧠 生成梳理（S15）</Btn>
          {!readonly && <Btn kind="danger" onClick={() => setClosing(true)}>结项（S8）</Btn>}
        </div>
      </div>

      {p.status === 'closed' && p.closeoutSummary && (
        <Card title="复盘摘要（结项自动生成，可读）"><div className="whitespace-pre-wrap text-[13px]">{p.closeoutSummary}</div></Card>
      )}

      <Card title={`任务面（${p.tasks.length}）${readonly ? ' · 只读' : ''}`} actions={!readonly ? <Btn small onClick={() => void 0} title="底部添加行">在下方添加</Btn> : undefined}>
        {p.tasks.length === 0 ? <Empty hint="暂无任务（自由创建项目可手工添加）" /> : (
          <table className="w-full text-[13px]">
            <thead className="text-left text-[12px] text-[var(--color-ink-soft)]">
              <tr className="border-b border-[var(--color-line)]">
                <th className="py-1.5">任务</th><th>责任人（唯一）</th><th>状态</th><th>计划开始</th><th>计划结束</th><th>标记</th>
              </tr>
            </thead>
            <tbody>
              {p.tasks.map((t) => (
                <tr key={t.id} className="border-b border-[var(--color-line)] last:border-0 hover:bg-[var(--color-bg)]">
                  <td className="py-1">
                    {readonly ? t.title : (
                      <InlineText value={t.title} onSubmit={async (v) => { await api.patchTask(t.id, { title: v }); await refresh() }} />
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
                  <td>
                    {readonly ? TASK_STATUS_LABEL[t.status] : (
                      <InlineSelect value={t.status} options={TASK_STATUS_LABEL} onSubmit={async (v) => { await api.patchTask(t.id, { status: v }); await refresh() }} />
                    )}
                  </td>
                  <td className="num">{readonly ? (t.planStartDate || '—') : <InlineText type="date" value={t.planStartDate} onSubmit={async (v) => { await api.patchTask(t.id, { planStartDate: v }); await refresh() }} />}</td>
                  <td className={`num ${t.isOverdue ? 'text-[var(--color-bad)]' : ''}`}>{readonly ? (t.planEndDate || '—') : <InlineText type="date" value={t.planEndDate} onSubmit={async (v) => { await api.patchTask(t.id, { planEndDate: v }); await refresh() }} />}</td>
                  <td>{t.isBlocked && <Badge tone="warn">被阻塞</Badge>}{t.isOverdue && <Badge tone="bad">逾期</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {!readonly && <AddTask projectId={id} onDone={refresh} />}
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card title={`里程碑（${p.milestones.length}）`}>
          {p.milestones.length === 0 ? <Empty hint="暂无里程碑" /> : (
            <ul className="space-y-1 text-[13px]">
              {p.milestones.map((m) => (
                <li key={m.id} className="flex items-center justify-between border-b border-[var(--color-line)] py-1 last:border-0">
                  <span>{m.name}</span>
                  <span className="num flex items-center gap-2">
                    {readonly ? (m.planDate || '—') : <InlineText type="date" value={m.planDate} onSubmit={async (v) => { await api.patchMilestone(m.id, { planDate: v }); await refresh() }} />}
                    <Badge tone={m.status === 'met' ? 'ok' : m.status === 'missed' ? 'bad' : 'muted'}>{m.status === 'met' ? '已达成' : m.status === 'missed' ? '已延误' : '计划中'}</Badge>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {!readonly && <AddMilestone projectId={id} onDone={refresh} />}
        </Card>

        <Card title={`核心渠道（${channels.length}）`} actions={!readonly ? <Btn small onClick={() => setBinding(true)}>绑定渠道</Btn> : undefined}>
          {channels.length === 0 ? <Empty hint="未绑定专题渠道（计入管理员待办）" /> : (
            <ul className="space-y-1 text-[13px]">
              {channels.map((c) => (
                <li key={c.id} className="flex items-center justify-between border-b border-[var(--color-line)] py-1 last:border-0">
                  <span><Badge tone="info">{c.platform === 'feishu' ? '飞书' : '企微'}</Badge> <span className="num">{c.groupKey}</span> {c.name}</span>
                  {!readonly && <Btn small kind="ghost" onClick={async () => { await api.deleteChannel(c.id); toast('已解绑'); await refresh() }}>解绑</Btn>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card title={`讨论面 · 事件流（${events.length}，append-only）`}>
        {events.length === 0 ? <Empty hint="暂无事件：绑定渠道后由大脑自动抽取，或手动添加" /> : (
          <ul className="space-y-2">
            {events.map((e) => (
              <li key={e.id} className="rounded-md border border-[var(--color-line)] p-2.5 text-[13px]">
                <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px] text-[var(--color-ink-soft)]">
                  <Badge tone={e.status === 'pending' ? 'warn' : e.status === 'effective' ? 'ok' : 'muted'}>{EVENT_STATUS_LABEL[e.status]}</Badge>
                  <Badge tone="muted">{EVENT_TYPE_LABEL[e.eventType] || e.eventType}</Badge>
                  <Badge tone={e.nature === 'suggestion' ? 'info' : 'muted'}>{e.nature === 'suggestion' ? '建议型' : '记录型'}</Badge>
                  {e.generatedBy === 'extraction' && <Badge tone="muted">IM 抽取</Badge>}
                  <span className="num">{new Date(e.businessTime).toLocaleString('zh-CN')}</span>
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
            ))}
          </ul>
        )}
        {!readonly && <AddEvent projectId={id} onDone={refresh} />}
      </Card>

      {closing && <CloseModal p={p} onClose={() => setClosing(false)} onDone={async () => { setClosing(false); toast('项目已结项归档'); await refresh() }} />}
      {binding && <BindChannelModal projectId={id} onClose={() => setBinding(false)} onDone={async () => { setBinding(false); toast('渠道已绑定'); await refresh() }} />}
      {digesting && (
        <Modal title="🧠 项目梳理（S15）" onClose={() => setDigesting(false)} wide>
          <DigestBody fn={() => api.projectDigest(id)} />
        </Modal>
      )}
    </div>
  )
}

function DigestBody({ fn }: { fn: () => Promise<Record<string, unknown>> }) {
  const [out, setOut] = useState<Record<string, unknown> | null>(null)
  const [err, setErr] = useState('')
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

function AddTask({ projectId, onDone }: { projectId: number; onDone: () => Promise<void> }) {
  const [title, setTitle] = useState('')
  return (
    <div className="mt-3 flex gap-2">
      <input className="cell-input" placeholder="新增任务标题（责任人默认牵头人，Enter 保存）" value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={async (e) => {
          if (e.key === 'Enter' && title.trim()) { await api.createTask({ projectId, title }); setTitle(''); await onDone() }
        }} />
    </div>
  )
}

function AddMilestone({ projectId, onDone }: { projectId: number; onDone: () => Promise<void> }) {
  const [name, setName] = useState('')
  const [date, setDate] = useState('')
  return (
    <div className="mt-3 flex gap-2">
      <input className="cell-input" placeholder="里程碑名" value={name} onChange={(e) => setName(e.target.value)} />
      <input type="date" className="cell-input w-40" value={date} onChange={(e) => setDate(e.target.value)} />
      <Btn small disabled={!name} onClick={async () => { await api.createMilestone({ projectId, name, planDate: date }); setName(''); setDate(''); await onDone() }}>添加</Btn>
    </div>
  )
}

function AddEvent({ projectId, onDone }: { projectId: number; onDone: () => Promise<void> }) {
  const [summary, setSummary] = useState('')
  const [type, setType] = useState('progress')
  return (
    <div className="mt-3 flex gap-2">
      <select className="cell-input w-28" value={type} onChange={(e) => setType(e.target.value)}>
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
  const open = p.tasks.filter((t) => ['todo', 'doing', 'blocked'].includes(t.status))
  const [disp, setDisp] = useState<Record<number, string>>({})
  const [summary, setSummary] = useState('')
  const [err, setErr] = useState('')
  const submit = async () => {
    try {
      await api.closeProject(p.id, {
        summary: summary || undefined,
        dispositions: open.map((t) => ({ taskId: t.id, action: disp[t.id] || 'cancelled' })),
      })
      await onDone()
    } catch (e) { setErr((e as Error).message) }
  }
  return (
    <Modal title="结项（S8）：未完任务逐项处置" onClose={onClose} wide>
      {open.length === 0 ? <div className="mb-3 text-[13px] text-[var(--color-ink-soft)]">无未完任务，可直接结项。</div> : (
        <table className="mb-3 w-full text-[13px]">
          <thead className="text-left text-[12px] text-[var(--color-ink-soft)]"><tr className="border-b border-[var(--color-line)]"><th className="py-1">任务</th><th>处置</th></tr></thead>
          <tbody>
            {open.map((t) => (
              <tr key={t.id} className="border-b border-[var(--color-line)] last:border-0">
                <td className="py-1">{t.title}</td>
                <td><InlineSelect value={disp[t.id] || 'cancelled'} options={{ cancelled: '取消', done: '完成' }} onSubmit={(v) => setDisp((d) => ({ ...d, [t.id]: v }))} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Field label="复盘摘要（留空则由大脑基于事件流自动生成）">
        <textarea className={inputCls} rows={3} value={summary} onChange={(e) => setSummary(e.target.value)} />
      </Field>
      {err && <div className="mb-3 rounded bg-red-50 px-2 py-1.5 text-[12px] text-[var(--color-bad)]">{err}</div>}
      <div className="flex justify-end gap-2">
        <Btn onClick={onClose}>取消</Btn>
        <Btn kind="danger" onClick={submit}>确认结项</Btn>
      </div>
      {err === '' && <div className="mt-2 text-[11px] text-[var(--color-ink-soft)]">结项后项目与任务面转只读，事件流保留。</div>}
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
