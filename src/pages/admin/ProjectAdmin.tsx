import { useEffect, useState } from 'react'
import { api } from '../../api'
import { useStore } from '../../store'
import { Badge, Btn, Card, Empty, Field, InlineText, Modal, Spinner, Tabs, inputCls } from '../../components/ui'
import { fmtDateTime } from '../../fmt'
import type { ChannelRow, ProjectRow, ProjectType } from '../../types'

// S48（v0.53）：未分拣消息行（通用群低置信池）
interface UnroutedRow { id: number; platform: string; groupKey: string; businessTime: number; speakerLabel: string | null; content: string }
import { ADMIN_SECTIONS } from './sections'

const TABS = ADMIN_SECTIONS[0].tabs

export default function ProjectAdmin({ tab }: { tab: string }) {
  const nav = (key: string) => { location.hash = `#/admin/project/${key}` }
  return (
    <div>
      <Tabs tabs={TABS} value={tab} onChange={nav} />
      {tab === 'types' && <TypesTab />}
      {tab === 'channels' && <ChannelsTab />}
      {tab === 'params' && <ParamsTab />}
    </div>
  )
}

// —— Tab 1：项目类型（S17-8，v0.18：任务清单内嵌于类型，单对象；编辑只影响未来立项）——

function TypesTab() {
  const { toast } = useStore()
  const [types, setTypes] = useState<ProjectType[] | null>(null)
  const [editing, setEditing] = useState<ProjectType | 'new' | null>(null)

  const refresh = async () => setTypes((await api.projectTypes()).types)
  useEffect(() => { void refresh() }, [])
  if (!types) return <Spinner />

  return (
    <div className="space-y-4">
      <Card
        title={`项目类型（${types.length}）：任务清单内嵌，立项时预填（可增删改，v0.18；任务可逐步骤挂参考资料，v0.33）`}
        actions={<Btn small onClick={() => setEditing('new')}>+ 新建类型</Btn>}
      >
        {types.length === 0 ? <Empty hint="暂无项目类型" /> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-[13px]">
              <thead className="text-left text-[12px] text-[var(--color-ink-soft)]">
                <tr className="border-b border-[var(--color-line)] [&>th]:whitespace-nowrap"><th className="py-1.5">编码</th><th>类型名</th><th>说明</th><th>任务数</th><th>在跑/历史项目</th><th>状态</th><th></th></tr>
              </thead>
              <tbody>
                {types.map((t) => (
                  <tr key={t.id} className="border-b border-[var(--color-line)] last:border-0">
                    <td className="py-1 font-mono">{t.code}</td>
                    <td><InlineText value={t.name} onSubmit={async (v) => { await api.patchProjectType(t.id, { name: v }); await refresh() }} /></td>
                    <td className="max-w-[22rem] truncate text-[var(--color-ink-soft)]" title={t.description || ''}>{t.description || '—'}</td>
                    <td className="num">{t.tasks.length}</td>
                    <td className="num">{t.openProjectCount} / {t.projectCount}</td>
                    <td><Badge tone={t.status === 'active' ? 'ok' : 'muted'}>{t.status === 'active' ? '启用' : '停用'}</Badge></td>
                    <td className="whitespace-nowrap">
                      <Btn small kind="ghost" onClick={() => setEditing(t)}>编辑</Btn>{' '}
                      <Btn small kind="ghost" onClick={async () => {
                        try {
                          await api.patchProjectType(t.id, { status: t.status === 'active' ? 'disabled' : 'active' })
                          toast(t.status === 'active' ? '已停用：立项不可再选，历史项目不受影响' : '已启用'); await refresh()
                        } catch (e) { toast((e as Error).message, 'bad') }
                      }}>{t.status === 'active' ? '停用' : '启用'}</Btn>{' '}
                      <Btn small kind="ghost" onClick={async () => {
                        if (!confirm(`删除类型「${t.name}（${t.code}）」？不可恢复；仍有项目引用会被拒绝。`)) return
                        try {
                          await api.deleteProjectType(t.id)
                          toast('类型已删除'); await refresh()
                        } catch (e) { toast((e as Error).message, 'bad') }
                      }}>删除</Btn>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {editing && <TypeEditor type={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onDone={async () => { setEditing(null); await refresh() }} />}
    </div>
  )
}

/** 类型编辑器（v0.18；v0.33 参考资料扩展）：任务标题仍每行一条批量维护（textarea / AI 起草习惯不变），
 * 「逐步骤参考资料」按顺序号给任务挂 SOP/知识库链接（名称+http(s) 链接+备注，每步 ≤10 条），
 * 参考按顺序号跟随标题行；保存时任务与参考随 tasks 整体替换（S17-8/S33）。 */
interface DraftRef { title: string; url: string; note: string }

function TypeEditor({ type, onClose, onDone }: { type: ProjectType | null; onClose: () => void; onDone: () => Promise<void> }) {
  const { toast } = useStore()
  const [form, setForm] = useState(() => type
    ? {
        code: type.code, name: type.name, description: type.description || '',
        initPrompt: type.initPrompt || '',
        tasksText: type.tasks.map((t) => t.title).join('\n'),
      }
    : { code: '', name: '', description: '', initPrompt: '', tasksText: '' })
  // 参考按「顺序号-1」挂任务（与 textarea 解析后的非空行一一对应；行数变少时超出的参考保存时丢弃）
  const [refs, setRefs] = useState<DraftRef[][]>(() =>
    type ? type.tasks.map((t) => (t.refs ?? []).map((r) => ({ title: r.title, url: r.url, note: r.note || '' }))) : [])
  const [err, setErr] = useState('')
  const [drafting, setDrafting] = useState(false)

  const titles = form.tasksText
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const orphanRefs = refs.slice(titles.length).reduce((s, r) => s + r.filter((x) => x.title.trim() || x.url.trim()).length, 0)

  const setLineRefs = (i: number, next: DraftRef[]) => {
    setRefs((prev) => { const cp = [...prev]; cp[i] = next; return cp })
  }

  const parse = () => ({
    tasks: titles.map((title, i) => ({ title, refs: refs[i] ?? [] })),
  })

  /** 客户端轻校验：参考行名称/链接须成对填（半填行提示，空行静默丢弃；完整校验在服务端 400 兜底）。 */
  const validateRefs = (): string => {
    for (let i = 0; i < refs.length; i++) {
      for (const r of refs[i] ?? []) {
        const half = !r.title.trim() !== !r.url.trim()
        if (half) return `第 ${i + 1} 步有参考资料缺名称或链接（成对填写；不需要的行点「删」）`
        if (r.url.trim() && !/^https?:\/\//i.test(r.url.trim())) return `第 ${i + 1} 步的参考链接须为 http(s)`
      }
    }
    return ''
  }

  return (
    <Modal title={type ? `编辑类型：${type.name}` : '新建项目类型'} onClose={onClose} wide>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Field label="类型编码 *（如 ops）">
          <input className={inputCls} value={form.code} disabled={!!type} onChange={(e) => setForm({ ...form, code: e.target.value })} title={type ? '编码创建后不可改' : undefined} />
        </Field>
        <Field label="类型名 *"><input className={inputCls} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <Field label="说明"><input className={inputCls} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
      </div>
      <Field label="默认任务清单（每行一条任务标题，按顺序；立项时预填、可增删改；无阶段、无预设依赖）">
        <textarea className={inputCls} rows={10} value={form.tasksText} onChange={(e) => setForm({ ...form, tasksText: e.target.value })} placeholder={'需求确认与范围冻结\n技术方案与排期\n开发联调\n结项复盘'} />
      </Field>
      {/* S39（v0.42）：初始化提示词——AI 初始分配读取的自然语言规则（任务分配逻辑 / 倒排日期逻辑） */}
      <Field label="初始化提示词（可选，≤2000 字；立项后项目详情页「✨ AI 初始分配」按它批量分配责任人与计划起止）">
        <textarea className={inputCls} rows={4} value={form.initPrompt} onChange={(e) => setForm({ ...form, initPrompt: e.target.value })}
          placeholder={'例：设计/文案类任务归内容组；开发与联调归交付部；彩排安排在交付前 3 天完成；验收放在交付日当天'} />
      </Field>
      <div className="mb-2 flex items-center gap-2">
        <Btn small disabled={!form.name.trim() || drafting} onClick={async () => {
          setDrafting(true); setErr('')
          try {
            const out = await api.draftProjectTasks({ name: form.name, description: form.description })
            setForm((f) => ({ ...f, tasksText: out.tasks.join('\n') }))
            toast(`AI 起草 ${out.tasks.length} 条任务，可继续编辑后保存（草稿未落库；参考资料按顺序号保留，请核对）`)
          } catch (e) { setErr((e as Error).message) } finally { setDrafting(false) }
        }}>{drafting ? 'AI 起草中…' : '✨ AI 起草任务清单'}</Btn>
        <span className="text-[11px] text-[var(--color-ink-soft)]">按类型名+说明生成草稿（S17-9）；需已在配置台配置 LLM（外部依赖 → LLM，任一类别均可）</span>
      </div>
      {err && <div className="mb-2 rounded bg-red-50 px-2 py-1 text-[12px] text-[var(--color-bad)]">{err}</div>}

      <Field label="逐步骤参考资料（SOP/知识库/表单链接；按上行号对应任务，立项时随任务预填给执行人，每步 ≤10 条）">
        {titles.length === 0 ? (
          <div className="text-[12px] text-[var(--color-ink-soft)]">先在上方填任务标题，这里会按行出现挂参考的入口。</div>
        ) : (
          <ul className="space-y-1.5 rounded-md border border-[var(--color-line)] p-2.5 text-[12px]">
            {titles.map((title, i) => (
              <li key={i}>
                <div className="flex items-center gap-2">
                  <span className="num w-5 shrink-0 text-right text-[var(--color-ink-soft)]">{i + 1}</span>
                  <span className="min-w-0 flex-1 truncate" title={title}>{title}</span>
                  {(refs[i]?.length ?? 0) > 0 && <span className="shrink-0 text-[var(--color-ink-soft)]">参考 {refs[i].length}</span>}
                  <Btn small kind="ghost" disabled={(refs[i]?.length ?? 0) >= 10} onClick={() => setLineRefs(i, [...(refs[i] ?? []), { title: '', url: '', note: '' }])}>+ 参考</Btn>
                </div>
                {(refs[i] ?? []).map((r, j) => (
                  <div key={j} className="mt-1 flex flex-wrap items-center gap-1 pl-7">
                    <input className={inputCls + ' !w-36'} placeholder="参考名称 *" value={r.title}
                      onChange={(e) => setLineRefs(i, refs[i].map((x, k) => (k === j ? { ...x, title: e.target.value } : x)))} />
                    <input className={inputCls + ' min-w-[12rem] flex-1 font-mono !text-[12px]'} placeholder="链接 https://… *" value={r.url}
                      onChange={(e) => setLineRefs(i, refs[i].map((x, k) => (k === j ? { ...x, url: e.target.value } : x)))} />
                    <input className={inputCls + ' !w-36'} placeholder="备注（可选）" value={r.note}
                      onChange={(e) => setLineRefs(i, refs[i].map((x, k) => (k === j ? { ...x, note: e.target.value } : x)))} />
                    <Btn small kind="ghost" onClick={() => setLineRefs(i, refs[i].filter((_, k) => k !== j))}>删</Btn>
                  </div>
                ))}
              </li>
            ))}
          </ul>
        )}
        {orphanRefs > 0 && (
          <div className="mt-1 text-[11px] text-[var(--color-warn,var(--color-bad))]">任务行数已少于挂参考的行数：第 {titles.length + 1} 步之后的 {orphanRefs} 条参考将在保存时丢弃。</div>
        )}
      </Field>

      <div className="text-[11px] text-[var(--color-ink-soft)]">编辑保存 = 任务清单与参考资料整体替换；已立项项目是立项时的实例拷贝，不受影响。</div>
      <div className="mt-3 flex justify-end gap-2">
        <Btn onClick={onClose}>取消</Btn>
        <Btn kind="primary" disabled={!form.code || !form.name} onClick={async () => {
          const refErr = validateRefs()
          if (refErr) { setErr(refErr); return }
          try {
            const parsed = parse()
            if (type) await api.patchProjectType(type.id, { name: form.name, description: form.description, initPrompt: form.initPrompt, ...parsed })
            else await api.createProjectType({ code: form.code, name: form.name, description: form.description, initPrompt: form.initPrompt, ...parsed })
            toast(type ? '类型已保存（只影响未来立项）' : '项目类型已创建'); await onDone()
          } catch (e) { setErr((e as Error).message) }
        }}>{type ? '保存' : '创建'}</Btn>
      </div>
    </Modal>
  )
}

// —— Tab 2：渠道（含未绑渠道待办）——

function ChannelsTab() {
  const [channels, setChannels] = useState<ChannelRow[] | null>(null)
  const [todo, setTodo] = useState<{ id: number; name: string; leadName: string }[]>([])
  const [unrouted, setUnrouted] = useState<UnroutedRow[] | null>(null)
  const reload = async () => {
    const [c, t, u] = await Promise.all([api.channels(), api.adminTodo(), api.unrouted()])
    setChannels(c.channels); setTodo(t.projects); setUnrouted(u.messages)
  }
  useEffect(() => { void reload() }, [])
  if (!channels) return <Spinner />
  return (
    <div className="space-y-4">
      {todo.length > 0 && (
        <Card title={`待办：${todo.length} 个在跑项目未绑定核心渠道`}>
          <ul className="space-y-1 text-[13px]">
            {todo.map((p) => <li key={p.id}>· <a className="text-[var(--color-brand)] hover:underline" href={`#/projects/${p.id}`}>{p.name}</a>（牵头 {p.leadName}）—— 去绑定飞书/企微专题群</li>)}
          </ul>
        </Card>
      )}
      <ChannelsCard channels={channels} onDone={reload} />
      {/* S48（v0.53，K31）：未分拣池消化——通用群低置信消息归挂到项目（重走抽取）或忽略 */}
      {unrouted && unrouted.length > 0 && <UnroutedCard messages={unrouted} onDone={reload} />}
    </div>
  )
}

// S48：未分拣消息卡片（仅管理员能进本页，接口同样仅管理员）
function UnroutedCard({ messages, onDone }: { messages: UnroutedRow[]; onDone: () => Promise<void> }) {
  const { toast } = useStore()
  const [projects, setProjects] = useState<ProjectRow[]>([])
  const [pick, setPick] = useState<Record<number, number>>({})
  useEffect(() => { void (async () => setProjects((await api.projects(['active'])).projects))() }, [])
  const route = async (id: number) => {
    const projectId = pick[id]
    if (!projectId) { toast('先选择要归挂的项目', 'bad'); return }
    const r = await api.routeUnrouted(id, projectId)
    toast(`已归挂到「${r.projectName}」：事件 ${r.events} 条、待确认建议 ${r.suggestions} 条`)
    await onDone()
  }
  return (
    <Card title={`未分拣消息（${messages.length}）：通用群低置信消息，归挂后重走抽取`}>
      <ul className="space-y-2 text-[13px]">
        {messages.map((m) => (
          <li key={m.id} className="border-b border-[var(--color-line)] pb-2" data-testid={`unrouted-${m.id}`}>
            <div className="text-[12px] text-[var(--color-ink-soft)]">{fmtDateTime(m.businessTime)} · {m.speakerLabel} · 群 {m.groupKey}</div>
            <div className="my-1">{m.content}</div>
            <div className="flex items-center gap-2">
              <select className={inputCls} value={pick[m.id] ?? ''} aria-label={`归挂项目（消息 ${m.id}）`}
                onChange={(e) => setPick({ ...pick, [m.id]: Number(e.target.value) })}>
                <option value="">选择项目…</option>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <Btn small kind="primary" onClick={() => void route(m.id)}>归挂到项目</Btn>
              <Btn small kind="ghost" onClick={async () => { await api.discardUnrouted(m.id); toast('已忽略'); await onDone() }}>忽略</Btn>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  )
}

function ChannelsCard({ channels, onDone }: { channels: ChannelRow[]; onDone: () => Promise<void> }) {
  const { toast } = useStore()
  const [form, setForm] = useState({ platform: 'feishu', groupKey: '', name: '', channelType: 'general' })
  // S18-1：立即对齐（手动增量抽取，回显每渠道结果；单渠道失败不阻塞）
  const align = async (channelId?: number) => {
    try {
      const r = await api.runExtraction(channelId ? { channelId } : {})
      const sum = (k: 'pulled' | 'events' | 'suggestions' | 'unrouted') => r.channels.reduce((s, c) => s + (c[k] ?? 0), 0)
      const errs = r.channels.filter((c) => c.error)
      toast(
        `对齐完成：拉取 ${sum('pulled')} 条 · 事件 ${sum('events')} · 建议 ${sum('suggestions')} · 未分拣 ${sum('unrouted')}` +
          (errs.length ? `；${errs.length} 个渠道失败（${errs[0].error}）` : ''),
        errs.length ? 'bad' : undefined,
      )
      await onDone()
    } catch (e) { toast((e as Error).message, 'bad') }
  }
  return (
    <Card title={`渠道（${channels.length}）：专题 1 群:1 项目；通用群由 LLM 分拣（D5）`}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Btn kind="primary" onClick={() => void align()}>立即对齐（全部渠道）</Btn>
        <span className="text-[12px] text-[var(--color-ink-soft)]">手动增量拉取并抽取新消息，更新项目最新状态（S18）</span>
      </div>
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <select className={inputCls + ' w-full sm:!w-28'} value={form.platform} onChange={(e) => setForm({ ...form, platform: e.target.value })}>
          <option value="feishu">飞书</option><option value="wecom">企业微信</option>
        </select>
        <select className={inputCls + ' w-full sm:!w-28'} value={form.channelType} onChange={(e) => setForm({ ...form, channelType: e.target.value })}>
          <option value="general">通用群</option><option value="dedicated">专题渠道</option>
        </select>
        <input className={inputCls + ' w-full sm:!w-44'} placeholder="群标识" value={form.groupKey} onChange={(e) => setForm({ ...form, groupKey: e.target.value })} />
        <input className={inputCls + ' w-full sm:!w-36'} placeholder="群名称" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
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
        <div className="overflow-x-auto">
          <table className="w-full min-w-[36rem] text-[13px]">
            <thead className="text-left text-[12px] text-[var(--color-ink-soft)]">
              <tr className="border-b border-[var(--color-line)] [&>th]:whitespace-nowrap"><th className="py-1.5">平台</th><th>群标识</th><th>名称</th><th>类型</th><th>绑定项目</th><th></th></tr>
            </thead>
            <tbody>
              {channels.map((c) => (
                <tr key={c.id} className="border-b border-[var(--color-line)] last:border-0">
                  <td className="py-1"><Badge tone="info">{c.platform === 'feishu' ? '飞书' : '企微'}</Badge></td>
                  <td className="num">{c.groupKey}</td><td>{c.name || '—'}</td>
                  <td>{c.channelType === 'dedicated' ? '专题' : '通用'}</td>
                  <td>{c.channelType === 'dedicated' ? `${c.projectId} ${c.projectName || ''}` : '（LLM 分拣）'}</td>
                  <td className="whitespace-nowrap">
                    <Btn small kind="ghost" onClick={() => void align(c.id)}>对齐</Btn>{' '}
                    <Btn small kind="ghost" onClick={async () => { await api.deleteChannel(c.id); toast('已删除'); await onDone() }}>删除</Btn>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

// —— Tab 3：阈值与推送 ——

interface Thresholds { silentDays: number; keypersonMaxProjects: number; acceptanceAlarm: number; suggestTimeoutHours: number; routingConfidence: number }
interface ChatCfg { quotaPerDay: number }
interface SchedulerCfg {
  extractionCron: string; extractionEnabled: boolean
  alertCron: string; alertEnabled: boolean
  reportCron: string; reportEnabled: boolean
  calendarSyncCron: string; calendarSyncEnabled: boolean
  backupCron: string; backupEnabled: boolean
  digestCron: string; digestEnabled: boolean
}

function ParamsTab() {
  const { toast } = useStore()
  const [thresholds, setThresholds] = useState<Thresholds | null>(null)
  const [sched, setSched] = useState<SchedulerCfg | null>(null)
  const [chat, setChat] = useState<ChatCfg | null>(null)
  useEffect(() => {
    void (async () => {
      const s = await api.settings()
      setThresholds(s.thresholds as Thresholds)
      setSched(s.scheduler as SchedulerCfg)
      setChat(s.chat as ChatCfg)
    })()
  }, [])
  if (!thresholds || !sched || !chat) return <Spinner />
  const num = (k: keyof Thresholds) => (
    <input type="number" step="0.05" className={inputCls} value={thresholds[k]} onChange={(e) => setThresholds({ ...thresholds, [k]: Number(e.target.value) })} />
  )
  const task = (cronKey: 'extractionCron' | 'alertCron' | 'reportCron' | 'calendarSyncCron' | 'backupCron' | 'digestCron', enabledKey: 'extractionEnabled' | 'alertEnabled' | 'reportEnabled' | 'calendarSyncEnabled' | 'backupEnabled' | 'digestEnabled', label: string) => (
    <div className="flex items-end gap-2">
      <Field label={label}>
        <input className={inputCls + ' font-mono !w-40'} value={sched[cronKey]} onChange={(e) => setSched({ ...sched, [cronKey]: e.target.value })} />
      </Field>
      <label className="flex items-center gap-1 pb-2 text-[12px]">
        <input type="checkbox" checked={sched[enabledKey]} onChange={(e) => setSched({ ...sched, [enabledKey]: e.target.checked })} />
        启用
      </label>
    </div>
  )
  return (
    <div className="space-y-4">
      <Card title="阈值（第 6 章指标口径，保存后全局视图即时刷新 S17-3）">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <Field label="沉默天数">{num('silentDays')}</Field>
          <Field label="关键人并行上限">{num('keypersonMaxProjects')}</Field>
          <Field label="采纳率告警线">{num('acceptanceAlarm')}</Field>
          <Field label="建议超时（小时）">{num('suggestTimeoutHours')}</Field>
          <Field label="通用群分拣置信度">{num('routingConfidence')}</Field>
        </div>
        <Btn kind="primary" onClick={async () => { await api.putSetting('thresholds', thresholds); toast('阈值已保存'); const s = await api.settings(); setThresholds(s.thresholds as Thresholds) }}>保存阈值</Btn>
      </Card>
      <Card title="AI 助手（S24，v0.16）：每成员每日指令限额（北京日，与审计同口径）">
        <div className="flex items-end gap-3">
          <Field label="每日指令限额">
            <input type="number" min={0} step={1} className={inputCls + ' !w-32'} value={chat.quotaPerDay}
              onChange={(e) => setChat({ ...chat, quotaPerDay: Number(e.target.value) })} />
          </Field>
          <Btn kind="primary" onClick={async () => { await api.putSetting('chat', chat); toast('AI 助手限额已保存'); const s = await api.settings(); setChat(s.chat as ChatCfg) }}>保存</Btn>
        </div>
      </Card>
      <Card title="大脑调度（S18，v0.7）：标准 cron「分 时 日 月 周」+ 每任务开关，保存即生效无需重启">
        <div className="flex flex-wrap items-end gap-3">
          {task('extractionCron', 'extractionEnabled', '信息更新对齐')}
          {task('alertCron', 'alertEnabled', '预警提醒')}
          {task('reportCron', 'reportEnabled', '日报提醒')}
          {task('calendarSyncCron', 'calendarSyncEnabled', '项目日历同步')}
          {task('backupCron', 'backupEnabled', '数据库备份')}
          {task('digestCron', 'digestEnabled', '每周梳理与周报')}
          <Btn kind="primary" onClick={async () => {
            try {
              await api.putSetting('scheduler', sched)
              toast('调度配置已保存')
            } catch (e) { toast((e as Error).message, 'bad') }
          }}>保存</Btn>
        </div>
        <p className="mt-2 text-[12px] leading-5 text-[var(--color-ink-soft)]">
          调度器随进程默认运行，心跳每分钟按配置判定。支持 *、*/n、a-b、a,b 与数字（周 0/7 均为周日）。日报停机错过时点当日补发、当日已发不重复。项目日历同步（S22）为对账式——初始化与手动同步在「外部依赖→飞书」。数据库备份（S34）的存储配置与连通性测试在「运维诊断→数据库备份」，存储未配全时静默跳过。
        </p>
      </Card>
    </div>
  )
}
