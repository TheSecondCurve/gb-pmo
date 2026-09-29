import { useEffect, useState } from 'react'
import { api } from '../api'
import { useStore } from '../store'
import { Badge, Btn, Card, Empty, Field, InlineText, Spinner, inputCls } from '../components/ui'
import type { ChannelRow, Member } from '../types'

// S17 配置台：设置页即控制台（tech-architecture 前端交互规范 §8：分区卡片、独立保存、测试连接）

interface Thresholds { silentDays: number; keypersonMaxProjects: number; acceptanceAlarm: number; suggestTimeoutHours: number; routingConfidence: number }
interface LlmCfg { baseUrl: string; apiKey: string; model: string; timeoutMs?: number }

export default function Admin() {
  const { member, toast } = useStore()
  const [members, setMembers] = useState<Member[] | null>(null)
  const [channels, setChannels] = useState<ChannelRow[] | null>(null)
  const [todo, setTodo] = useState<{ id: number; name: string; leadName: string }[]>([])
  const [thresholds, setThresholds] = useState<Thresholds | null>(null)
  const [llm, setLlm] = useState<LlmCfg | null>(null)

  const refresh = async () => {
    const [m, c, t, s] = await Promise.all([api.members(), api.channels(), api.adminTodo(), api.settings()])
    setMembers(m.members); setChannels(c.channels); setTodo(t.projects)
    setThresholds(s.thresholds as Thresholds); setLlm(s.llm as LlmCfg)
  }
  useEffect(() => { void refresh() }, [])

  if (!members || !channels || !thresholds || !llm) return <Spinner />

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-bold">配置台 <span className="text-[12px] font-normal text-[var(--color-ink-soft)]">管理员视图 · 变更即审计留痕</span></h1>

      {todo.length > 0 && (
        <Card title={`管理员待办：${todo.length} 个项目未绑定核心渠道`}>
          <ul className="space-y-1 text-[13px]">
            {todo.map((p) => <li key={p.id}>· <a className="text-[var(--color-brand)] hover:underline" href={`#/projects/${p.id}`}>{p.name}</a>（牵头 {p.leadName}）—— 去绑定飞书/企微专题群</li>)}
          </ul>
        </Card>
      )}

      <MembersCard members={members} onDone={refresh} />
      <ChannelsCard channels={channels} onDone={refresh} />
      <ThresholdsCard thresholds={thresholds} onSaved={refresh} toast={toast} />
      <LlmCard llm={llm} onSaved={refresh} toast={toast} />
      <ImCard toast={toast} />
      <TokensCard />
      <DigestCard memberId={member?.id ?? 0} toast={toast} />
    </div>
  )
}

function MembersCard({ members, onDone }: { members: Member[]; onDone: () => Promise<void> }) {
  const { toast } = useStore()
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({ name: '', username: '', password: '', feishuId: '', wecomId: '', team: '', isKeyPerson: false, maxParallelProjects: 3, role: 'member' })
  const [err, setErr] = useState('')
  return (
    <Card title={`成员身份表（${members.length}，身份脊柱：飞书/企微 id 是抽取归因 join key）`} actions={<Btn small onClick={() => setAdding(!adding)}>{adding ? '收起' : '+ 添加成员'}</Btn>}>
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
                <option value="member">普通成员</option><option value="admin">管理员</option>
              </select>
            </Field>
            <label className="mt-5 flex items-center gap-2 text-[13px]">
              <input type="checkbox" checked={form.isKeyPerson} onChange={(e) => setForm({ ...form, isKeyPerson: e.target.checked })} /> 关键人
            </label>
          </div>
          {err && <div className="mb-2 rounded bg-red-50 px-2 py-1 text-[12px] text-[var(--color-bad)]">{err}</div>}
          <Btn kind="primary" disabled={!form.name || !form.username || !form.password} onClick={async () => {
            try { await api.createMember(form); setAdding(false); setForm({ ...form, name: '', username: '', password: '' }); toast('成员已创建'); await onDone() } catch (e) { setErr((e as Error).message) }
          }}>创建</Btn>
        </div>
      )}
      <table className="w-full text-[13px]">
        <thead className="text-left text-[12px] text-[var(--color-ink-soft)]">
          <tr className="border-b border-[var(--color-line)]"><th className="py-1.5">姓名</th><th>用户名</th><th>飞书 id</th><th>企微 id</th><th>团队</th><th>关键人</th><th>并行上限</th><th>状态</th><th></th></tr>
        </thead>
        <tbody>
          {members.map((m) => (
            <tr key={m.id} className="border-b border-[var(--color-line)] last:border-0 hover:bg-[var(--color-bg)]">
              <td className="py-1">{m.name}</td>
              <td className="num">{m.username}</td>
              <td><InlineText value={m.feishuId} placeholder="未绑" onSubmit={async (v) => { await api.patchMember(m.id, { feishuId: v }); toast('飞书 id 已更新（后续抽取按新 id 归因）'); await onDone() }} /></td>
              <td><InlineText value={m.wecomId} placeholder="未绑" onSubmit={async (v) => { await api.patchMember(m.id, { wecomId: v }); await onDone() }} /></td>
              <td><InlineText value={m.team} placeholder="—" onSubmit={async (v) => { await api.patchMember(m.id, { team: v }); await onDone() }} /></td>
              <td>{m.isKeyPerson ? '★' : ''}</td>
              <td className="num"><InlineText type="number" value={m.maxParallelProjects} onSubmit={async (v) => { await api.patchMember(m.id, { maxParallelProjects: Number(v) }); await onDone() }} /></td>
              <td><Badge tone={m.status === 'active' ? 'ok' : 'muted'}>{m.status === 'active' ? '在职' : '离职'}</Badge>{m.role === 'admin' && <Badge tone="info">管理员</Badge>}</td>
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
                        toast('已离职并完成转交（会话与令牌联动失效）'); await onDone()
                      } catch (e2) { toast((e2 as Error).message, 'bad') }
                    } else toast((e as Error).message, 'bad')
                  }
                }}>离职</Btn>
              )}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  )
}

function ChannelsCard({ channels, onDone }: { channels: ChannelRow[]; onDone: () => Promise<void> }) {
  const { toast } = useStore()
  const [form, setForm] = useState({ platform: 'feishu', groupKey: '', name: '', channelType: 'general' })
  return (
    <Card title={`渠道（${channels.length}）：专题 1 群:1 项目；通用群由 LLM 分拣（D5）`}>
      <div className="mb-3 flex flex-wrap gap-2">
        <select className={inputCls + ' !w-28'} value={form.platform} onChange={(e) => setForm({ ...form, platform: e.target.value })}>
          <option value="feishu">飞书</option><option value="wecom">企业微信</option>
        </select>
        <select className={inputCls + ' !w-28'} value={form.channelType} onChange={(e) => setForm({ ...form, channelType: e.target.value })}>
          <option value="general">通用群</option><option value="dedicated">专题渠道</option>
        </select>
        <input className={inputCls + ' !w-44'} placeholder="群标识" value={form.groupKey} onChange={(e) => setForm({ ...form, groupKey: e.target.value })} />
        <input className={inputCls + ' !w-36'} placeholder="群名称" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        {form.channelType === 'dedicated' && (
          <input className={inputCls + ' !w-24'} type="number" placeholder="项目 id" onChange={(e) => setForm({ ...form, channelType: 'dedicated', ...({ projectId: e.target.value } as object) })} />
        )}
        <Btn disabled={!form.groupKey} onClick={async () => {
          try {
            const body: Record<string, unknown> = { platform: form.platform, groupKey: form.groupKey, name: form.name, channelType: form.channelType }
            if (form.channelType === 'dedicated') {
              const pid = prompt('专题渠道需绑定项目 id：')
              if (!pid) return
              body.projectId = Number(pid)
            }
            await api.upsertChannel(body)
            setForm({ ...form, groupKey: '', name: '' }); toast('渠道已保存'); await onDone()
          } catch (e) { toast((e as Error).message, 'bad') }
        }}>保存</Btn>
      </div>
      {channels.length === 0 ? <Empty hint="暂无渠道" /> : (
        <table className="w-full text-[13px]">
          <thead className="text-left text-[12px] text-[var(--color-ink-soft)]">
            <tr className="border-b border-[var(--color-line)]"><th className="py-1.5">平台</th><th>群标识</th><th>名称</th><th>类型</th><th>绑定项目</th><th></th></tr>
          </thead>
          <tbody>
            {channels.map((c) => (
              <tr key={c.id} className="border-b border-[var(--color-line)] last:border-0">
                <td className="py-1"><Badge tone="info">{c.platform === 'feishu' ? '飞书' : '企微'}</Badge></td>
                <td className="num">{c.groupKey}</td><td>{c.name || '—'}</td>
                <td>{c.channelType === 'dedicated' ? '专题' : '通用'}</td>
                <td>{c.channelType === 'dedicated' ? `${c.projectId} ${c.projectName || ''}` : '（LLM 分拣）'}</td>
                <td><Btn small kind="ghost" onClick={async () => { await api.deleteChannel(c.id); toast('已删除'); await onDone() }}>删除</Btn></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  )
}

function ThresholdsCard({ thresholds, onSaved, toast }: { thresholds: Thresholds; onSaved: () => Promise<void>; toast: (m: string, k?: 'ok' | 'bad') => void }) {
  const [t, setT] = useState(thresholds)
  useEffect(() => setT(thresholds), [thresholds])
  const num = (k: keyof Thresholds) => (
    <input type="number" step="0.05" className={inputCls} value={t[k]} onChange={(e) => setT({ ...t, [k]: Number(e.target.value) })} />
  )
  return (
    <Card title="阈值（第 6 章指标口径，保存后全局视图即时刷新 S17-3）">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Field label="沉默天数">{num('silentDays')}</Field>
        <Field label="关键人并行上限">{num('keypersonMaxProjects')}</Field>
        <Field label="采纳率告警线">{num('acceptanceAlarm')}</Field>
        <Field label="建议超时（小时）">{num('suggestTimeoutHours')}</Field>
        <Field label="通用群分拣置信度">{num('routingConfidence')}</Field>
      </div>
      <Btn kind="primary" onClick={async () => { await api.putSetting('thresholds', t); toast('阈值已保存'); await onSaved() }}>保存阈值</Btn>
    </Card>
  )
}

function LlmCard({ llm, onSaved, toast }: { llm: LlmCfg; onSaved: () => Promise<void>; toast: (m: string, k?: 'ok' | 'bad') => void }) {
  const [cfg, setCfg] = useState(llm)
  const [result, setResult] = useState('')
  useEffect(() => setCfg(llm), [llm])
  return (
    <Card title="LLM（DeepSeek，OpenAI 兼容；未配置时大脑走确定性降级）">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Field label="Base URL"><input className={inputCls} value={cfg.baseUrl} onChange={(e) => setCfg({ ...cfg, baseUrl: e.target.value })} /></Field>
        <Field label="API Key（留空=不改）"><input className={inputCls} type="password" value={cfg.apiKey} onChange={(e) => setCfg({ ...cfg, apiKey: e.target.value })} /></Field>
        <Field label="模型"><input className={inputCls} value={cfg.model} onChange={(e) => setCfg({ ...cfg, model: e.target.value })} /></Field>
      </div>
      <div className="flex items-center gap-2">
        <Btn kind="primary" onClick={async () => { await api.putSetting('llm', cfg); toast('LLM 配置已保存'); await onSaved() }}>保存</Btn>
        <Btn onClick={async () => {
          const r = await api.testLlm(cfg)
          setResult(r.ok ? `✅ 连接成功：${r.sample || ''}` : `❌ ${r.reason}`)
          if (!r.ok) toast(r.reason || '连接失败', 'bad')
        }}>测试连接（S17-4）</Btn>
        {result && <span className="text-[12px]">{result}</span>}
      </div>
    </Card>
  )
}

function ImCard({ toast }: { toast: (m: string, k?: 'ok' | 'bad') => void }) {
  const [feishu, setFeishu] = useState({ appId: '', appSecret: '' })
  const [wecom, setWecom] = useState({ corpId: '', secret: '', publicKeyVer: '', privateKey: '', sdkUrl: '' })
  const [results, setResults] = useState<Record<string, string>>({})
  return (
    <Card title="IM 接入（申请与配置步骤见 docs/prd.md 附录 A）">
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <div className="mb-2 text-[12px] font-semibold">飞书（自建应用 + 机器人进群 + im:message.group_msg）</div>
          <Field label="App ID"><input className={inputCls} value={feishu.appId} onChange={(e) => setFeishu({ ...feishu, appId: e.target.value })} /></Field>
          <Field label="App Secret"><input className={inputCls} type="password" value={feishu.appSecret} onChange={(e) => setFeishu({ ...feishu, appSecret: e.target.value })} /></Field>
          <div className="flex gap-2">
            <Btn kind="primary" onClick={async () => { await api.putSetting('im.feishu', feishu); toast('飞书配置已保存') }}>保存</Btn>
            <Btn onClick={async () => { const r = await api.testIm('feishu'); setResults({ ...results, feishu: r.ok ? '✅ 连接成功' : `❌ ${r.reason}` }) }}>测试连接</Btn>
          </div>
          {results.feishu && <div className="mt-1 text-[12px]">{results.feishu}</div>}
        </div>
        <div>
          <div className="mb-2 text-[12px] font-semibold">企业微信（会话存档：付费开通 + RSA 公钥 + 官方 C SDK 代理）</div>
          <Field label="Corp ID"><input className={inputCls} value={wecom.corpId} onChange={(e) => setWecom({ ...wecom, corpId: e.target.value })} /></Field>
          <Field label="会话存档 Secret"><input className={inputCls} type="password" value={wecom.secret} onChange={(e) => setWecom({ ...wecom, secret: e.target.value })} /></Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="公钥版本"><input className={inputCls} value={wecom.publicKeyVer} onChange={(e) => setWecom({ ...wecom, publicKeyVer: e.target.value })} /></Field>
            <Field label="SDK 代理地址"><input className={inputCls} placeholder="http://…/（未部署见附录 A.2）" value={wecom.sdkUrl} onChange={(e) => setWecom({ ...wecom, sdkUrl: e.target.value })} /></Field>
          </div>
          <Field label="RSA 私钥（PEM）"><textarea className={inputCls} rows={3} value={wecom.privateKey} onChange={(e) => setWecom({ ...wecom, privateKey: e.target.value })} /></Field>
          <div className="flex gap-2">
            <Btn kind="primary" onClick={async () => { await api.putSetting('im.wecom', wecom); toast('企微配置已保存') }}>保存</Btn>
            <Btn onClick={async () => { const r = await api.testIm('wecom'); setResults({ ...results, wecom: r.ok ? '✅ 连接成功' : `❌ ${r.reason}` }) }}>测试连接（S17-5）</Btn>
          </div>
          {results.wecom && <div className="mt-1 text-[12px]">{results.wecom}</div>}
        </div>
      </div>
    </Card>
  )
}

function TokensCard() {
  const { toast } = useStore()
  const [tokens, setTokens] = useState<{ id: number; name: string; tokenPrefix: string; scope: string; expiresAt: number; revokedAt?: number | null }[] | null>(null)
  const [issued, setIssued] = useState('')
  useEffect(() => { void api.tokens().then((r) => setTokens(r.tokens)) }, [])
  if (!tokens) return <Card title="Agent 令牌（PAT）"><Spinner /></Card>
  return (
    <Card title={`我的 Agent 令牌（PAT，90 天）`} actions={
      <Btn small onClick={async () => {
        const scope = confirm('签发读写令牌（write）？取消则签发只读（read）') ? 'write' : 'read'
        const r = await api.issueToken(scope, 'web-issued')
        setIssued(r.token); toast('令牌已签发（仅此一次展示）')
        const t = await api.tokens(); setTokens(t.tokens)
      }}>+ 签发令牌</Btn>
    }>
      {issued && <div className="mb-2 break-all rounded bg-[var(--color-brand-soft)] p-2 font-mono text-[12px]">{issued}</div>}
      {tokens.length === 0 ? <Empty hint="暂无令牌" /> : (
        <table className="w-full text-[13px]">
          <thead className="text-left text-[12px] text-[var(--color-ink-soft)]">
            <tr className="border-b border-[var(--color-line)]"><th className="py-1.5">名称</th><th>前缀</th><th>scope</th><th>过期</th><th>状态</th><th></th></tr>
          </thead>
          <tbody>
            {tokens.map((t) => (
              <tr key={t.id} className="border-b border-[var(--color-line)] last:border-0">
                <td className="py-1">{t.name}</td><td className="num font-mono">{t.tokenPrefix}…</td>
                <td><Badge tone={t.scope === 'write' ? 'warn' : 'muted'}>{t.scope}</Badge></td>
                <td className="num">{new Date(t.expiresAt).toLocaleDateString('zh-CN')}</td>
                <td>{t.revokedAt ? <Badge tone="muted">已吊销</Badge> : <Badge tone="ok">有效</Badge>}</td>
                <td>{!t.revokedAt && <Btn small kind="ghost" onClick={async () => { await api.revokeToken(t.id); const r = await api.tokens(); setTokens(r.tokens); toast('已吊销') }}>吊销</Btn>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="mt-2 text-[11px] text-[var(--color-ink-soft)]">
        Agent 接入：curl -fsSL http://&lt;服务器&gt;/agent/skill/gb-pmo/install.sh | sh && curl -fsSL http://&lt;服务器&gt;/agent/login.sh | sh
      </div>
    </Card>
  )
}

function DigestCard({ memberId, toast }: { memberId: number; toast: (m: string, k?: 'ok' | 'bad') => void }) {
  const [out, setOut] = useState('')
  return (
    <Card title="大脑手动触发（Agent 亦可经 action 端点触发，D4）">
      <div className="flex flex-wrap items-center gap-2">
        <Btn onClick={async () => {
          const r = (await api.personDigest(memberId)) as { narrative: string; taskCount: number; overdueCount: number; conflictCount: number }
          setOut(`个人梳理：${r.narrative}（任务 ${r.taskCount} / 逾期 ${r.overdueCount} / 冲突 ${r.conflictCount}）`)
        }}>🧠 我的梳理（S16）</Btn>
        <Btn onClick={async () => {
          const r = (await fetch('/api/v1/agent/metrics', { credentials: 'same-origin' }).then(() => null).catch(() => null))
          void r
          toast('日报由调度器每日推送，也可让 Agent 执行 action push_report', 'ok')
        }}>日报说明</Btn>
      </div>
      {out && <div className="mt-2 rounded bg-[var(--color-bg)] p-2 text-[13px]">{out}</div>}
    </Card>
  )
}
