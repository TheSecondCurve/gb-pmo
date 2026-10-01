import { useEffect, useState } from 'react'
import { api } from '../api'
import { useStore } from '../store'
import { Badge, Btn, Card, Empty, Field, InlineSelect, Modal, Spinner, inputCls } from '../components/ui'
import { PRIORITY_LABEL, type Member, type ProjectRow, type ProjectType } from '../types'

export default function Projects() {
  const { toast } = useStore()
  const [projects, setProjects] = useState<ProjectRow[] | null>(null)
  const [members, setMembers] = useState<Member[]>([])
  const [creating, setCreating] = useState(false)
  const [unassigned, setUnassigned] = useState<number>(0)

  const refresh = async () => {
    const [p, m, u] = await Promise.all([api.projects(), api.members(), api.unassigned()])
    setProjects(p.projects); setMembers(m.members); setUnassigned(u.tasks.length)
  }
  useEffect(() => { void refresh() }, [])

  if (!projects) return <Spinner />

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-bold">项目列表 {unassigned > 0 && <Badge tone="bad">未指派任务 {unassigned}</Badge>}</h1>
        <Btn kind="primary" onClick={() => setCreating(true)}>+ 立项</Btn>
      </div>

      <Card>
        {projects.length === 0 ? <Empty hint="暂无项目" /> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-[13px]">
              <thead className="text-left text-[12px] text-[var(--color-ink-soft)]">
                <tr className="border-b border-[var(--color-line)] [&>th]:whitespace-nowrap">
                  <th className="py-1.5">优先级</th><th>项目</th><th>牵头人</th><th>状态</th>
                  <th className="num">逾期</th><th>交付周期（S21）</th><th>类型</th>
                </tr>
              </thead>
              <tbody>
                {projects.map((p) => (
                  <tr key={p.id} className="border-b border-[var(--color-line)] last:border-0 hover:bg-[var(--color-bg)]">
                    <td className="py-1">
                      <InlineSelect value={p.priority} options={PRIORITY_LABEL} onSubmit={async (v) => {
                        await api.patchProject(p.id, { priority: v }); toast('优先级已调整并留痕'); await refresh()
                      }} />
                    </td>
                    <td><a className="text-[var(--color-brand)] hover:underline" href={`#/projects/${p.id}`}>{p.name}</a>{p.clientName ? <span className="text-[var(--color-ink-soft)]">（{p.clientName}）</span> : null}</td>
                    <td>{p.leadName}</td>
                    <td>
                      <InlineSelect value={p.status} options={{ planning: '待启动', active: '进行中', paused: '已暂停', cancelled: '已取消' }} onSubmit={async (v) => {
                        try { await api.patchProject(p.id, { status: v }); toast('状态已更新'); await refresh() } catch (e) { toast((e as Error).message, 'bad') }
                      }} />
                    </td>
                    <td className={`num ${p.overdueTasks ? 'text-[var(--color-bad)]' : ''}`}>{p.overdueTasks}</td>
                    <td className="num">
                      {p.planStartDate || '?'} ~ {p.planEndDate || '?'}{' '}
                      {p.daysToDelivery != null && (p.daysToDelivery >= 0
                        ? <Badge tone={p.daysToDelivery <= 3 ? 'warn' : 'muted'}>{p.daysToDelivery === 0 ? '今日交付' : `剩 ${p.daysToDelivery} 天`}</Badge>
                        : <Badge tone="bad">超期 {-p.daysToDelivery} 天</Badge>)}
                    </td>
                    <td className="text-[var(--color-ink-soft)]">{p.typeName || p.templateCode}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {creating && <CreateModal members={members} onClose={() => setCreating(false)} onDone={async () => { setCreating(false); toast('立项成功'); await refresh() }} />}
    </div>
  )
}

function CreateModal({ members, onClose, onDone }: { members: Member[]; onClose: () => void; onDone: () => Promise<void> }) {
  const { toast } = useStore()
  const [types, setTypes] = useState<ProjectType[]>([])
  const [form, setForm] = useState({ name: '', typeCode: '', leadMemberId: '', priority: 'medium', clientName: '', planStartDate: '', planEndDate: '' })
  const [tasksText, setTasksText] = useState('')
  const [tasksDirty, setTasksDirty] = useState(false) // 未改动=按类型清单实例化（source=template）；改动过=自定义（source=manual）
  const [backfill, setBackfill] = useState(false) // S1-7：按交付日期倒排任务计划起止
  const [schedule, setSchedule] = useState<{ planStartDate: string; planEndDate: string }[] | null>(null)
  const [drafting, setDrafting] = useState(false)
  const [err, setErr] = useState('')
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }))

  useEffect(() => {
    void (async () => {
      const t = await api.projectTypes()
      const active = t.types.filter((x) => x.status === 'active')
      setTypes(active)
      if (active.length) {
        setForm((f) => ({ ...f, typeCode: f.typeCode || active[0].code }))
        setTasksText(active[0].tasks.map((x) => x.title).join('\n'))
      }
    })()
  }, [])

  const chosen = types.find((t) => t.code === form.typeCode)
  // 切类型：未手改过清单则跟随预填；改过则保留（用户已表达自定义意图）
  const switchType = (code: string) => {
    set('typeCode', code)
    if (!tasksDirty) setTasksText((types.find((t) => t.code === code)?.tasks ?? []).map((x) => x.title).join('\n'))
  }
  const titles = tasksText.split('\n').map((l) => l.trim()).filter(Boolean)

  // 倒排预览：engine 同一公式（POST preview-schedule，不落库）
  useEffect(() => {
    if (!backfill || !form.planEndDate || titles.length === 0) { setSchedule(null); return }
    let alive = true
    void (async () => {
      try {
        const out = await api.previewSchedule({ planStartDate: form.planStartDate || undefined, planEndDate: form.planEndDate, count: titles.length })
        if (alive) setSchedule(out.schedule)
      } catch { if (alive) setSchedule(null) }
    })()
    return () => { alive = false }
  }, [backfill, form.planStartDate, form.planEndDate, titles.length])

  const submit = async () => {
    try {
      await api.createProject({
        ...form, leadMemberId: Number(form.leadMemberId),
        ...(tasksDirty ? { tasks: titles } : {}), // 未改动→缺省按类型清单（S1-2）；改动过→显式覆盖（S1-6，空清单=空项目）
        ...(backfill && form.planEndDate ? { autoSchedule: true } : {}),
      })
      await onDone()
    } catch (e) { setErr((e as Error).message) }
  }

  return (
    <Modal title="立项（S1）" onClose={onClose} wide>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Field label="项目名 *"><input className={inputCls} value={form.name} onChange={(e) => set('name', e.target.value)} /></Field>
        <Field label="项目类型（预填任务清单，可在下方自由增删改；类型在配置台维护）">
          <select className={inputCls} value={form.typeCode} onChange={(e) => switchType(e.target.value)}>
            {types.map((t) => (
              <option key={t.code} value={t.code}>{t.name}（{t.tasks.length} 项任务）</option>
            ))}
          </select>
        </Field>
      </div>
      {chosen?.description && <div className="-mt-2 mb-3 text-[11px] text-[var(--color-ink-soft)]">{chosen.description}</div>}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Field label="牵头人 *（必填，任务默认责任人）">
          <select className={inputCls} value={form.leadMemberId} onChange={(e) => set('leadMemberId', e.target.value)}>
            <option value="">选择成员…</option>
            {members.filter((m) => m.status === 'active').map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </Field>
        <Field label="优先级">
          <select className={inputCls} value={form.priority} onChange={(e) => set('priority', e.target.value)}>
            {Object.entries(PRIORITY_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </Field>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="客户（可选）"><input className={inputCls} value={form.clientName} onChange={(e) => set('clientName', e.target.value)} /></Field>
        <Field label="计划开始"><input type="date" className={inputCls} value={form.planStartDate} onChange={(e) => set('planStartDate', e.target.value)} /></Field>
        <Field label="交付日期（S21：切「进行中」前必填）"><input type="date" className={inputCls} value={form.planEndDate} onChange={(e) => set('planEndDate', e.target.value)} /></Field>
      </div>
      <Field label={`任务清单（每行一条；选类型自动预填${tasksDirty ? '，已自定义' : ''}；留空=空项目）`}>
        <textarea className={inputCls} rows={8} value={tasksText} onChange={(e) => { setTasksText(e.target.value); setTasksDirty(true) }} placeholder={'需求确认与范围冻结\n技术方案与排期\n开发联调\n结项复盘'} />
      </Field>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Btn small disabled={!form.name.trim() || drafting} onClick={async () => {
          setDrafting(true); setErr('')
          try {
            const out = await api.draftProjectTasks({ name: form.name, description: chosen?.description || form.clientName })
            setTasksText(out.tasks.join('\n')); setTasksDirty(true)
            toast(`AI 起草 ${out.tasks.length} 条任务，可继续编辑（草稿未落库）`)
          } catch (e) { setErr((e as Error).message) } finally { setDrafting(false) }
        }}>{drafting ? 'AI 起草中…' : '✨ AI 起草任务清单'}</Btn>
        <label className="flex items-center gap-1 text-[12px]">
          <input type="checkbox" checked={backfill} disabled={!form.planEndDate} onChange={(e) => setBackfill(e.target.checked)} />
          按交付日期倒排任务计划起止（均分，S1-7）
        </label>
        {!form.planEndDate && <span className="text-[11px] text-[var(--color-ink-soft)]">填交付日期后可倒排</span>}
      </div>
      {backfill && schedule && schedule.length === titles.length && titles.length > 0 && (
        <div className="mb-3 rounded-md border border-[var(--color-line)] p-2 text-[12px] leading-5">
          <div className="mb-1 text-[var(--color-ink-soft)]">倒排预览（末条截止 = 交付日期 {form.planEndDate}；立项后可再调整）：</div>
          {titles.map((t, i) => (
            <div key={i} className="flex gap-2"><span className="num text-[var(--color-ink-soft)]">{schedule[i].planStartDate} ~ {schedule[i].planEndDate}</span><span className="truncate">{t}</span></div>
          ))}
        </div>
      )}
      {err && <div className="mb-3 rounded bg-red-50 px-2 py-1.5 text-[12px] text-[var(--color-bad)]">{err}</div>}
      <div className="flex justify-end gap-2">
        <Btn onClick={onClose}>取消</Btn>
        <Btn kind="primary" disabled={!form.name || !form.leadMemberId || !form.typeCode} onClick={submit}>立项</Btn>
      </div>
      <div className="mt-2 text-[11px] text-[var(--color-ink-soft)]">立项后请在详情页绑定核心渠道（飞书/企微专题群），未绑定会计入管理员待办。</div>
    </Modal>
  )
}
