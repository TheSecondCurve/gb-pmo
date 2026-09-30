import { useEffect, useState } from 'react'
import { fmtDate } from '../../fmt'
import { api } from '../../api'
import { useStore } from '../../store'
import { Badge, Btn, Card, Empty, Field, InlineSelect, InlineText, Spinner, Tabs, inputCls } from '../../components/ui'
import type { Member } from '../../types'
import { ROLE_LABEL } from '../../types'
import { ADMIN_SECTIONS } from './sections'

const TABS = ADMIN_SECTIONS[1].tabs

export default function UserAdmin({ tab }: { tab: string }) {
  const nav = (key: string) => { location.hash = `#/admin/users/${key}` }
  return (
    <div>
      <Tabs tabs={TABS} value={tab} onChange={nav} />
      {tab === 'members' && <MembersTab />}
      {tab === 'tokens' && <TokensTab />}
    </div>
  )
}

// —— Tab 1：成员身份表（含角色配置，S17-6/S17-7）——

function MembersTab() {
  const { toast, member: me } = useStore()
  const [members, setMembers] = useState<Member[] | null>(null)
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({ name: '', username: '', password: '', feishuId: '', wecomId: '', team: '', isKeyPerson: false, maxParallelProjects: 3, role: 'member' })
  const [err, setErr] = useState('')

  const refresh = async () => { const m = await api.members(); setMembers(m.members) }
  useEffect(() => { void refresh() }, [])
  if (!members) return <Spinner />

  const changeRole = async (m: Member, role: string) => {
    if (m.id === me?.id && m.role === 'admin' && role === 'member') {
      if (!confirm(`把自己降级为成员？降级后将无法进入配置台（其他系统管理员仍可再把你升回）`)) return
      if (!confirm('再次确认：确定降级自己？')) return
    }
    try {
      await api.patchMember(m.id, { role })
      toast(`${m.name} 角色已改为${ROLE_LABEL[role]}`); await refresh()
    } catch (e) { toast((e as Error).message, 'bad') }
  }

  return (
    <Card
      title={`成员身份表（${members.length}，身份脊柱：飞书/企微 id 是抽取归因 join key）`}
      actions={<Btn small onClick={() => setAdding(!adding)}>{adding ? '收起' : '+ 添加成员'}</Btn>}
    >
      {adding && (
        <div className="mb-3 rounded-md border border-[var(--color-line)] p-3">
          <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
            <Field label="姓名 *"><input className={inputCls} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
            <Field label="用户名 *"><input className={inputCls} value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} /></Field>
            <Field label="初始密码 *"><input className={inputCls} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></Field>
            <Field label="飞书 id"><input className={inputCls} value={form.feishuId} onChange={(e) => setForm({ ...form, feishuId: e.target.value })} /></Field>
            <Field label="企微 id"><input className={inputCls} value={form.wecomId} onChange={(e) => setForm({ ...form, wecomId: e.target.value })} /></Field>
            <Field label="团队"><input className={inputCls} value={form.team} onChange={(e) => setForm({ ...form, team: e.target.value })} /></Field>
            <Field label="并行项目上限"><input type="number" className={inputCls} value={form.maxParallelProjects} onChange={(e) => setForm({ ...form, maxParallelProjects: Number(e.target.value) })} /></Field>
            <Field label="角色">
              <select className={inputCls} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                <option value="member">成员</option><option value="admin">系统管理员</option>
              </select>
            </Field>
            <label className="mt-5 flex items-center gap-2 text-[13px]">
              <input type="checkbox" checked={form.isKeyPerson} onChange={(e) => setForm({ ...form, isKeyPerson: e.target.checked })} /> 关键人
            </label>
          </div>
          {err && <div className="mb-2 rounded bg-red-50 px-2 py-1 text-[12px] text-[var(--color-bad)]">{err}</div>}
          <Btn kind="primary" disabled={!form.name || !form.username || !form.password} onClick={async () => {
            try { await api.createMember(form); setAdding(false); setForm({ ...form, name: '', username: '', password: '' }); toast('成员已创建'); await refresh() } catch (e) { setErr((e as Error).message) }
          }}>创建</Btn>
        </div>
      )}
      <table className="w-full text-[13px]">
        <thead className="text-left text-[12px] text-[var(--color-ink-soft)]">
          <tr className="border-b border-[var(--color-line)]"><th className="py-1.5">姓名</th><th>用户名</th><th>飞书 id</th><th>企微 id</th><th>团队</th><th>关键人</th><th>并行上限</th><th>角色</th><th>状态</th><th></th></tr>
        </thead>
        <tbody>
          {members.map((m) => (
            <tr key={m.id} className="border-b border-[var(--color-line)] last:border-0 hover:bg-[var(--color-bg)]">
              <td className="py-1">{m.name}</td>
              <td className="num">{m.username}</td>
              <td><InlineText value={m.feishuId} placeholder="未绑" onSubmit={async (v) => { await api.patchMember(m.id, { feishuId: v }); toast('飞书 id 已更新（后续抽取按新 id 归因）'); await refresh() }} /></td>
              <td><InlineText value={m.wecomId} placeholder="未绑" onSubmit={async (v) => { await api.patchMember(m.id, { wecomId: v }); await refresh() }} /></td>
              <td><InlineText value={m.team} placeholder="—" onSubmit={async (v) => { await api.patchMember(m.id, { team: v }); await refresh() }} /></td>
              <td>{m.isKeyPerson ? '★' : ''}</td>
              <td className="num"><InlineText type="number" value={m.maxParallelProjects} onSubmit={async (v) => { await api.patchMember(m.id, { maxParallelProjects: Number(v) }); await refresh() }} /></td>
              <td><InlineSelect value={m.role} options={ROLE_LABEL} onSubmit={(v) => changeRole(m, v)} /></td>
              <td><Badge tone={m.status === 'active' ? 'ok' : 'muted'}>{m.status === 'active' ? '在职' : '离职'}</Badge></td>
              <td>{m.status === 'active' && (
                <Btn small kind="danger" onClick={async () => {
                  if (!confirm(`离职 ${m.name}：需先转交其名下任务与牵头项目，继续？`)) return
                  try {
                    await api.offboardMember(m.id, {})
                    toast('存在未转交项，请在弹窗中处理', 'bad')
                  } catch (e) {
                    const data = (e as { data?: { missingTasks?: number[]; missingProjects?: number[] } }).data
                    if (data?.missingTasks || data?.missingProjects) {
                      const toId = prompt(`待转交：任务 ${data.missingTasks?.length || 0} 项、项目 ${data.missingProjects?.length || 0} 个。输入转交给谁的成员 id（1=${members[0]?.name}）`)
                      if (!toId) return
                      try {
                        await api.offboardMember(m.id, {
                          tasks: (data.missingTasks || []).map((id) => ({ taskId: id, toMemberId: Number(toId) })),
                          projects: (data.missingProjects || []).map((id) => ({ projectId: id, toMemberId: Number(toId) })),
                        })
                        toast('已离职并完成转交（会话与令牌联动失效）'); await refresh()
                      } catch (e2) { toast((e2 as Error).message, 'bad') }
                    } else toast((e as Error).message, 'bad')
                  }
                }}>离职</Btn>
              )}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-2 text-[11px] text-[var(--color-ink-soft)]">
        角色两档：系统管理员（进配置台、管成员角色）/ 成员；最后一名在职系统管理员不可被降级或离职（S17-7）。
      </div>
    </Card>
  )
}

// —— Tab 2：令牌治理（全员 PAT 视图 + 吊销；签发走命令行，PRD v0.5 拍板）——

function TokensTab() {
  const { toast } = useStore()
  const [byMember, setByMember] = useState<Record<string, { id: number; name: string; tokenPrefix: string; scope: string; expiresAt: number; revokedAt?: number | null }[]> | null>(null)
  const [memberNames, setMemberNames] = useState<Record<string, string>>({})
  const refresh = async () => {
    const [t, m] = await Promise.all([api.adminTokens(), api.members()])
    setByMember(t.tokensByMember)
    setMemberNames(Object.fromEntries(m.members.map((x) => [String(x.id), x.name])))
  }
  useEffect(() => { void refresh() }, [])
  if (!byMember) return <Spinner />
  const entries = Object.entries(byMember)
  return (
    <Card title={`Agent 令牌（PAT）治理：${entries.reduce((s, [, list]) => s + list.filter((t) => !t.revokedAt).length, 0)} 个有效`}>
      <div className="mb-2 text-[11px] text-[var(--color-ink-soft)]">
        成员自助签发走命令行：curl -fsSL http://&lt;服务器&gt;/agent/skill/gb-pmo/install.sh | sh &amp;&amp; curl -fsSL http://&lt;服务器&gt;/agent/login.sh | sh；此处仅查看与吊销。
      </div>
      {entries.length === 0 ? <Empty hint="暂无任何成员签发过令牌" /> : entries.map(([mid, list]) => (
        <div key={mid} className="mb-3">
          <div className="mb-1 text-[12px] font-semibold">{memberNames[mid] || `成员 #${mid}`}</div>
          <table className="w-full text-[13px]">
            <thead className="text-left text-[12px] text-[var(--color-ink-soft)]">
              <tr className="border-b border-[var(--color-line)]"><th className="py-1">名称</th><th>前缀</th><th>scope</th><th>过期</th><th>状态</th><th></th></tr>
            </thead>
            <tbody>
              {list.map((t) => (
                <tr key={t.id} className="border-b border-[var(--color-line)] last:border-0">
                  <td className="py-1">{t.name}</td><td className="num font-mono">{t.tokenPrefix}…</td>
                  <td><Badge tone={t.scope === 'write' ? 'warn' : 'muted'}>{t.scope}</Badge></td>
                  <td className="num">{fmtDate(t.expiresAt)}</td>
                  <td>{t.revokedAt ? <Badge tone="muted">已吊销</Badge> : <Badge tone="ok">有效</Badge>}</td>
                  <td>{!t.revokedAt && <Btn small kind="ghost" onClick={async () => {
                    if (!confirm('吊销该令牌？对应 Agent 立即失去访问权')) return
                    await api.revokeAdminToken(t.id); toast('已吊销'); await refresh()
                  }}>吊销</Btn>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </Card>
  )
}
