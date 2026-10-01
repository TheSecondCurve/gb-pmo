import { useEffect, useState } from 'react'
import { api } from '../../api'
import { useStore } from '../../store'
import { Badge, Btn, Card, Empty, Field, InlineSelect, InlineText, Modal, Spinner, Tabs, inputCls } from '../../components/ui'
import type { ChannelRow, ProjectType, TemplateRow } from '../../types'
import { ADMIN_SECTIONS } from './sections'

const TABS = ADMIN_SECTIONS[0].tabs

export default function ProjectAdmin({ tab }: { tab: string }) {
  const nav = (key: string) => { location.hash = `#/admin/project/${key}` }
  return (
    <div>
      <Tabs tabs={TABS} value={tab} onChange={nav} />
      {tab === 'types' && <TypesTemplatesTab />}
      {tab === 'channels' && <ChannelsTab />}
      {tab === 'params' && <ParamsTab />}
    </div>
  )
}

// —— Tab 1：项目类型 ↔ 任务模板（S17-8：一类型绑一默认模板，多类型可共用）——

function TypesTemplatesTab() {
  const { toast } = useStore()
  const [types, setTypes] = useState<ProjectType[] | null>(null)
  const [templates, setTemplates] = useState<TemplateRow[] | null>(null)
  const [addingType, setAddingType] = useState(false)
  const [typeForm, setTypeForm] = useState({ code: '', name: '', description: '', defaultTemplateId: 0 })
  const [editingTpl, setEditingTpl] = useState<TemplateRow | 'new' | null>(null)

  const refresh = async () => {
    const [t, tp] = await Promise.all([api.projectTypes(), api.adminTemplates()])
    setTypes(t.types); setTemplates(tp.templates)
  }
  useEffect(() => { void refresh() }, [])
  if (!types || !templates) return <Spinner />

  const templateOptions = Object.fromEntries(templates.map((t) => [String(t.id), t.name]))

  return (
    <div className="space-y-4">
      <Card
        title={`项目类型（${types.length}）：立项时选类型即套用其绑定模板`}
        actions={<Btn small onClick={() => { setAddingType(!addingType); setTypeForm({ code: '', name: '', description: '', defaultTemplateId: templates[0]?.id || 0 }) }}>{addingType ? '收起' : '+ 新建类型'}</Btn>}
      >
        {addingType && (
          <div className="mb-3 grid grid-cols-2 gap-2 rounded-md border border-[var(--color-line)] p-3 md:grid-cols-4">
            <Field label="类型编码 *（如 ops）"><input className={inputCls} value={typeForm.code} onChange={(e) => setTypeForm({ ...typeForm, code: e.target.value })} /></Field>
            <Field label="类型名 *"><input className={inputCls} value={typeForm.name} onChange={(e) => setTypeForm({ ...typeForm, name: e.target.value })} /></Field>
            <Field label="绑定默认模板 *">
              <select className={inputCls} value={typeForm.defaultTemplateId} onChange={(e) => setTypeForm({ ...typeForm, defaultTemplateId: Number(e.target.value) })}>
                {templates.map((t) => <option key={t.id} value={t.id}>{t.name}（{t.code}）</option>)}
              </select>
            </Field>
            <Field label="说明"><input className={inputCls} value={typeForm.description} onChange={(e) => setTypeForm({ ...typeForm, description: e.target.value })} /></Field>
            <div>
              <Btn kind="primary" disabled={!typeForm.code || !typeForm.name || !typeForm.defaultTemplateId} onClick={async () => {
                try {
                  await api.createProjectType(typeForm)
                  setAddingType(false); toast('项目类型已创建'); await refresh()
                } catch (e) { toast((e as Error).message, 'bad') }
              }}>创建</Btn>
            </div>
          </div>
        )}
        {types.length === 0 ? <Empty hint="暂无项目类型" /> : (
          <table className="w-full text-[13px]">
            <thead className="text-left text-[12px] text-[var(--color-ink-soft)]">
              <tr className="border-b border-[var(--color-line)]"><th className="py-1.5">编码</th><th>类型名</th><th>绑定默认模板（可换绑）</th><th>在跑/历史项目</th><th>状态</th><th></th></tr>
            </thead>
            <tbody>
              {types.map((t) => (
                <tr key={t.id} className="border-b border-[var(--color-line)] last:border-0">
                  <td className="py-1 font-mono">{t.code}</td>
                  <td><InlineText value={t.name} onSubmit={async (v) => { await api.patchProjectType(t.id, { name: v }); await refresh() }} /></td>
                  <td>
                    <InlineSelect value={String(t.defaultTemplateId)} options={templateOptions} onSubmit={async (v) => {
                      try { await api.patchProjectType(t.id, { defaultTemplateId: Number(v) }); toast('已换绑默认模板（只影响之后立项）'); await refresh() }
                      catch (e) { toast((e as Error).message, 'bad') }
                    }} />
                  </td>
                  <td className="num">{t.openProjectCount} / {t.projectCount}</td>
                  <td><Badge tone={t.status === 'active' ? 'ok' : 'muted'}>{t.status === 'active' ? '启用' : '停用'}</Badge></td>
                  <td>
                    <Btn small kind="ghost" onClick={async () => {
                      try {
                        await api.patchProjectType(t.id, { status: t.status === 'active' ? 'disabled' : 'active' })
                        toast(t.status === 'active' ? '已停用：立项不可再选，历史项目不受影响' : '已启用'); await refresh()
                      } catch (e) { toast((e as Error).message, 'bad') }
                    }}>{t.status === 'active' ? '停用' : '启用'}</Btn>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card
        title={`任务模板（${templates.length}）：任务清单，编辑只影响未来立项`}
        actions={<Btn small onClick={() => setEditingTpl('new')}>+ 新建模板</Btn>}
      >
        {templates.length === 0 ? <Empty hint="暂无模板" /> : (
          <table className="w-full text-[13px]">
            <thead className="text-left text-[12px] text-[var(--color-ink-soft)]">
              <tr className="border-b border-[var(--color-line)]"><th className="py-1.5">编码</th><th>模板名</th><th>任务数</th><th>绑定类型/使用项目</th><th></th></tr>
            </thead>
            <tbody>
              {templates.map((t) => (
                <tr key={t.id} className="border-b border-[var(--color-line)] last:border-0">
                  <td className="py-1 font-mono">{t.code}</td>
                  <td>{t.name}</td>
                  <td className="num">{t.tasks.length}</td>
                  <td className="num">{t.typeCount} / {t.projectCount}</td>
                  <td className="whitespace-nowrap">
                    <Btn small kind="ghost" onClick={() => setEditingTpl(t)}>编辑</Btn>{' '}
                    <Btn small kind="ghost" onClick={async () => {
                      if (!confirm(`删除模板「${t.name}」？仅无类型绑定且无项目使用时可删`)) return
                      try { await api.deleteTemplate(t.id); toast('模板已删除'); await refresh() } catch (e) { toast((e as Error).message, 'bad') }
                    }}>删除</Btn>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {editingTpl && <TemplateEditor template={editingTpl === 'new' ? null : editingTpl} onClose={() => setEditingTpl(null)} onDone={async () => { setEditingTpl(null); await refresh() }} />}
    </div>
  )
}

/** 模板编辑器（v0.6）：纯任务清单，每行一条任务标题；给出即整体替换（S17-8） */
function TemplateEditor({ template, onClose, onDone }: { template: TemplateRow | null; onClose: () => void; onDone: () => Promise<void> }) {
  const { toast } = useStore()
  const [form, setForm] = useState(() => template
    ? {
        code: template.code, name: template.name, description: template.description || '',
        tasksText: template.tasks.map((t) => t.title).join('\n'),
      }
    : { code: '', name: '', description: '', tasksText: '' })
  const [err, setErr] = useState('')
  const [drafting, setDrafting] = useState(false)

  const parse = () => {
    const tasks = form.tasksText
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((title) => ({ title }))
    return { tasks }
  }

  return (
    <Modal title={template ? `编辑模板：${template.name}` : '新建任务模板'} onClose={onClose} wide>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Field label="模板编码 *（如 sre_ops）">
          <input className={inputCls} value={form.code} disabled={!!template} onChange={(e) => setForm({ ...form, code: e.target.value })} title={template ? '编码创建后不可改' : undefined} />
        </Field>
        <Field label="模板名 *"><input className={inputCls} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <Field label="说明"><input className={inputCls} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
      </div>
      <Field label="默认任务清单（每行一条任务标题，按顺序；v0.6：无阶段、无预设依赖）">
        <textarea className={inputCls} rows={10} value={form.tasksText} onChange={(e) => setForm({ ...form, tasksText: e.target.value })} placeholder={'需求确认与范围冻结\n技术方案与排期\n开发联调\n结项复盘'} />
      </Field>
      <div className="mb-2 flex items-center gap-2">
        <Btn small disabled={!form.name.trim() || drafting} onClick={async () => {
          setDrafting(true); setErr('')
          try {
            const out = await api.draftTemplateTasks({ name: form.name, description: form.description })
            setForm((f) => ({ ...f, tasksText: out.tasks.join('\n') }))
            toast(`AI 起草 ${out.tasks.length} 条任务，可继续编辑后保存（草稿未落库）`)
          } catch (e) { setErr((e as Error).message) } finally { setDrafting(false) }
        }}>{drafting ? 'AI 起草中…' : '✨ AI 起草任务清单'}</Btn>
        <span className="text-[11px] text-[var(--color-ink-soft)]">按模板名+说明生成草稿（S17-9）；需已在配置台配置 LLM（外部依赖 → LLM，任一类别均可）</span>
      </div>
      {err && <div className="mb-2 rounded bg-red-50 px-2 py-1 text-[12px] text-[var(--color-bad)]">{err}</div>}
      <div className="text-[11px] text-[var(--color-ink-soft)]">编辑保存 = 任务清单整体替换；已立项项目是立项时的实例拷贝，不受影响。</div>
      <div className="mt-3 flex justify-end gap-2">
        <Btn onClick={onClose}>取消</Btn>
        <Btn kind="primary" disabled={!form.code || !form.name} onClick={async () => {
          let parsed
          try { parsed = parse() } catch (e) { setErr((e as Error).message); return }
          try {
            if (template) await api.patchTemplate(template.id, { name: form.name, description: form.description, ...parsed })
            else await api.createTemplate({ code: form.code, name: form.name, description: form.description, ...parsed })
            toast(template ? '模板已保存（只影响未来立项）' : '模板已创建'); await onDone()
          } catch (e) { setErr((e as Error).message) }
        }}>{template ? '保存' : '创建'}</Btn>
      </div>
    </Modal>
  )
}

// —— Tab 2：渠道（含未绑渠道待办）——

function ChannelsTab() {
  const [channels, setChannels] = useState<ChannelRow[] | null>(null)
  const [todo, setTodo] = useState<{ id: number; name: string; leadName: string }[]>([])
  useEffect(() => {
    void (async () => {
      const [c, t] = await Promise.all([api.channels(), api.adminTodo()])
      setChannels(c.channels); setTodo(t.projects)
    })()
  }, [])
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
      <ChannelsCard channels={channels} onDone={async () => { const c = await api.channels(); setChannels(c.channels); const t = await api.adminTodo(); setTodo(t.projects) }} />
    </div>
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
      <div className="mb-3 flex flex-wrap gap-2">
        <select className={inputCls + ' !w-28'} value={form.platform} onChange={(e) => setForm({ ...form, platform: e.target.value })}>
          <option value="feishu">飞书</option><option value="wecom">企业微信</option>
        </select>
        <select className={inputCls + ' !w-28'} value={form.channelType} onChange={(e) => setForm({ ...form, channelType: e.target.value })}>
          <option value="general">通用群</option><option value="dedicated">专题渠道</option>
        </select>
        <input className={inputCls + ' !w-44'} placeholder="群标识" value={form.groupKey} onChange={(e) => setForm({ ...form, groupKey: e.target.value })} />
        <input className={inputCls + ' !w-36'} placeholder="群名称" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
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
                <td className="whitespace-nowrap">
                  <Btn small kind="ghost" onClick={() => void align(c.id)}>对齐</Btn>{' '}
                  <Btn small kind="ghost" onClick={async () => { await api.deleteChannel(c.id); toast('已删除'); await onDone() }}>删除</Btn>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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
  const task = (cronKey: 'extractionCron' | 'alertCron' | 'reportCron' | 'calendarSyncCron', enabledKey: 'extractionEnabled' | 'alertEnabled' | 'reportEnabled' | 'calendarSyncEnabled', label: string) => (
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
          <Btn kind="primary" onClick={async () => {
            try {
              await api.putSetting('scheduler', sched)
              toast('调度配置已保存')
            } catch (e) { toast((e as Error).message, 'bad') }
          }}>保存</Btn>
        </div>
        <p className="mt-2 text-[12px] leading-5 text-[var(--color-ink-soft)]">
          调度器随进程默认运行，心跳每分钟按配置判定。支持 *、*/n、a-b、a,b 与数字（周 0/7 均为周日）。日报停机错过时点当日补发、当日已发不重复。项目日历同步（S22）为对账式——初始化与手动同步在「外部依赖→飞书」。
        </p>
      </Card>
    </div>
  )
}
