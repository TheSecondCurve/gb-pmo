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
          <table className="w-full text-[13px]">
            <thead className="text-left text-[12px] text-[var(--color-ink-soft)]">
              <tr className="border-b border-[var(--color-line)]">
                <th className="py-1.5">优先级</th><th>项目</th><th>牵头人</th><th>状态</th>
                <th className="num">逾期</th><th>计划周期</th><th>类型</th>
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
                  <td className="num">{p.planStartDate || '?'} ~ {p.planEndDate || '?'}</td>
                  <td className="text-[var(--color-ink-soft)]">{p.typeName || p.templateCode}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {creating && <CreateModal members={members} onClose={() => setCreating(false)} onDone={async () => { setCreating(false); toast('立项成功'); await refresh() }} />}
    </div>
  )
}

function CreateModal({ members, onClose, onDone }: { members: Member[]; onClose: () => void; onDone: () => Promise<void> }) {
  const [types, setTypes] = useState<ProjectType[]>([])
  const [form, setForm] = useState({ name: '', typeCode: '', leadMemberId: '', priority: 'medium', clientName: '', planStartDate: '', planEndDate: '' })
  const [err, setErr] = useState('')
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }))
  useEffect(() => {
    void (async () => {
      const t = await api.projectTypes()
      const active = t.types.filter((x) => x.status === 'active')
      setTypes(active)
      if (active.length) setForm((f) => ({ ...f, typeCode: f.typeCode || active[0].code }))
    })()
  }, [])
  const chosen = types.find((t) => t.code === form.typeCode)
  const submit = async () => {
    try {
      await api.createProject({ ...form, leadMemberId: Number(form.leadMemberId) })
      await onDone()
    } catch (e) { setErr((e as Error).message) }
  }
  return (
    <Modal title="立项（S1）" onClose={onClose}>
      <Field label="项目名 *"><input className={inputCls} value={form.name} onChange={(e) => set('name', e.target.value)} /></Field>
      <Field label="项目类型（决定默认任务模板；类型与模板在配置台维护）">
        <select className={inputCls} value={form.typeCode} onChange={(e) => set('typeCode', e.target.value)}>
          {types.map((t) => (
            <option key={t.code} value={t.code}>{t.name}（{t.defaultTemplateName || ''}）</option>
          ))}
        </select>
      </Field>
      {chosen?.description && <div className="-mt-2 mb-3 text-[11px] text-[var(--color-ink-soft)]">{chosen.description}</div>}
      <Field label="牵头人 *（必填，模板任务默认责任人）">
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
      <div className="grid grid-cols-2 gap-3">
        <Field label="客户（可选）"><input className={inputCls} value={form.clientName} onChange={(e) => set('clientName', e.target.value)} /></Field>
        <Field label="计划开始"><input type="date" className={inputCls} value={form.planStartDate} onChange={(e) => set('planStartDate', e.target.value)} /></Field>
      </div>
      <Field label="计划结束"><input type="date" className={inputCls} value={form.planEndDate} onChange={(e) => set('planEndDate', e.target.value)} /></Field>
      {err && <div className="mb-3 rounded bg-red-50 px-2 py-1.5 text-[12px] text-[var(--color-bad)]">{err}</div>}
      <div className="flex justify-end gap-2">
        <Btn onClick={onClose}>取消</Btn>
        <Btn kind="primary" disabled={!form.name || !form.leadMemberId} onClick={submit}>立项</Btn>
      </div>
      <div className="mt-2 text-[11px] text-[var(--color-ink-soft)]">立项后请在详情页绑定核心渠道（飞书/企微专题群），未绑定会计入管理员待办。</div>
    </Modal>
  )
}
