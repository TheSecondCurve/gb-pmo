import { useEffect, useState } from 'react'
import { api } from '../../api'
import { useStore } from '../../store'
import { Btn, Card, Field, Spinner, Tabs, inputCls } from '../../components/ui'
import { ADMIN_SECTIONS } from './sections'

const TABS = ADMIN_SECTIONS[2].tabs

export default function IntegrationAdmin({ tab }: { tab: string }) {
  const nav = (key: string) => { location.hash = `#/admin/integrations/${key}` }
  return (
    <div>
      <Tabs tabs={TABS} value={tab} onChange={nav} />
      {tab === 'llm' && <LlmCard />}
      {tab === 'feishu' && <FeishuCard />}
      {tab === 'wecom' && <WecomCard />}
    </div>
  )
}

interface LlmSub { apiKey: string; baseUrl: string; model: string }
interface LlmCfg { provider: string; deepseek: LlmSub; 'glm-coding': LlmSub; timeoutMs?: number }

// LLM 类别目录（S17-11）：与 server/engine/enums.js 的 LLM_PROVIDERS 保持一致
const LLM_PROVIDERS: { key: string; label: string; baseUrl: string; model: string; note?: string }[] = [
  { key: 'deepseek', label: 'DeepSeek（OpenAI 兼容）', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
  {
    key: 'glm-coding', label: 'GLM 国内 Coding Plan（智谱）',
    baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', model: 'glm-5.3',
    note: 'GLM 国内 Coding Plan：用套餐 API Key，走智谱官方 OpenAI 兼容编码端点（模型 glm-5.3 / glm-5.3-Flash）。注意：套餐额度仅对官方指定编码工具抵扣，本系统属自建服务，调用可能按标准 API 按量计费。',
  },
]

function LlmCard() {
  const { toast } = useStore()
  const [cfg, setCfg] = useState<LlmCfg | null>(null)
  const [active, setActive] = useState('deepseek') // 当前编辑/测试的类别；「保存」后成为生效类别
  const [result, setResult] = useState('')
  const [usage, setUsage] = useState<Awaited<ReturnType<typeof api.llmUsage>> | null>(null)
  useEffect(() => {
    void (async () => {
      const s = await api.settings()
      const llm = s.llm as LlmCfg
      // 两类分开存（v0.15）：子配置端点/模型为空时按类别默认补齐展示（保存时服务端同样归一化）
      const backfilled = { ...llm } as Record<string, unknown>
      for (const p of LLM_PROVIDERS) {
        const cur = (llm as unknown as Record<string, LlmSub | undefined>)[p.key] ?? { apiKey: '', baseUrl: '', model: '' }
        backfilled[p.key] = { apiKey: cur.apiKey ?? '', baseUrl: cur.baseUrl || p.baseUrl, model: cur.model || p.model }
      }
      setCfg(backfilled as unknown as LlmCfg)
      setActive(llm.provider || 'deepseek')
      setUsage(await api.llmUsage(7).catch(() => null)) // S47：近 7 天用量摘要（失败不阻塞卡片）
    })()
  }, [])
  if (!cfg) return <Spinner />
  const provider = LLM_PROVIDERS.find((p) => p.key === active) ?? LLM_PROVIDERS[0]
  const sub: LlmSub = (cfg as unknown as Record<string, LlmSub | undefined>)[provider.key] ?? { apiKey: '', baseUrl: provider.baseUrl, model: provider.model }
  const shown = { baseUrl: sub.baseUrl || provider.baseUrl, model: sub.model || provider.model, apiKey: sub.apiKey ?? '' }
  const setSub = (patch: Partial<LlmSub>) =>
    setCfg({ ...cfg, [provider.key]: { ...shown, ...patch } } as LlmCfg)
  return (
    <Card title="LLM（OpenAI 兼容：DeepSeek / GLM 国内 Coding Plan；各类别分开保存，切换即生效；未配置时大脑走确定性降级）">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
        <Field label="类别（当前编辑；保存后生效）">
          <select className={inputCls} value={provider.key} onChange={(e) => setActive(e.target.value)}>
            {LLM_PROVIDERS.map((p) => <option key={p.key} value={p.key}>{p.label}{cfg.provider === p.key ? '（生效中）' : ''}</option>)}
          </select>
        </Field>
        <Field label="Base URL（留空=类别默认）"><input className={inputCls} value={shown.baseUrl} onChange={(e) => setSub({ baseUrl: e.target.value })} /></Field>
        <Field label="API Key"><input className={inputCls} type="password" value={shown.apiKey} onChange={(e) => setSub({ apiKey: e.target.value })} /></Field>
        <Field label="模型"><input className={inputCls} value={shown.model} onChange={(e) => setSub({ model: e.target.value })} /></Field>
        {/* S40（v0.43）：超时可直接在配置台编辑（此前仅 Agent put_setting 可调）；GLM 大 JSON 场景建议 ≥120s */}
        <Field label="超时（秒，1~600；大 JSON 输出建议 ≥120）">
          <input className={inputCls} type="number" min={1} max={600} value={Math.round((cfg.timeoutMs ?? 120000) / 1000)}
            onChange={(e) => setCfg({ ...cfg, timeoutMs: Number(e.target.value) * 1000 })} />
        </Field>
      </div>
      {provider.note && <p className="mb-3 text-[12px] text-[var(--color-ink-soft)]">{provider.note}</p>}
      <div className="flex items-center gap-2">
        <Btn kind="primary" onClick={async () => {
          await api.putSetting('llm', { provider: provider.key, ...shown, timeoutMs: cfg.timeoutMs })
          toast(`已保存并切换生效类别：${provider.label}`)
          const s = await api.settings(); setCfg(s.llm as LlmCfg); setActive((s.llm as LlmCfg).provider)
        }}>保存（含切换生效类别）</Btn>
        <Btn onClick={async () => {
          const r = await api.testLlm({ provider: provider.key, ...shown })
          setResult(r.ok ? `✅ 连接成功（${provider.label}）：${r.sample || ''}` : `❌ ${r.reason}`)
          if (!r.ok) toast(r.reason || '连接失败', 'bad')
        }}>测试连接（当前类别，S17-4）</Btn>
        {result && <span className="text-[12px]">{result}</span>}
      </div>
      {/* S47（v0.52，K30）：近 7 天 LLM 用量摘要（用途×调用数/token/失败）——成本优化的数据依据 */}
      {usage && (
        <div className="mt-3 border-t border-[var(--color-line)] pt-2" data-testid="llm-usage">
          <div className="mb-1 text-[12px] text-[var(--color-ink-soft)]">近 7 天用量（按用途）</div>
          {usage.byPurpose.length === 0 ? (
            <div className="text-[12px] text-[var(--color-ink-soft)]">暂无 LLM 调用记录</div>
          ) : (
            <table className="w-full text-[12px]">
              <thead><tr className="text-left text-[var(--color-ink-soft)]"><th className="py-0.5">用途</th><th>调用</th><th>Token（入/出）</th><th>失败</th></tr></thead>
              <tbody>
                {usage.byPurpose.map((r) => (
                  <tr key={r.purpose} className="border-t border-[var(--color-line)]">
                    <td className="py-0.5">{r.purpose}</td>
                    <td className="num">{r.calls}</td>
                    <td className="num">{r.promptTokens}/{r.completionTokens}</td>
                    <td className={`num ${r.errors ? 'text-[var(--color-bad)]' : ''}`}>{r.errors}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </Card>
  )
}

function FeishuCard() {
  const { toast } = useStore()
  const [cfg, setCfg] = useState<{
    appId: string; appSecret: string
    botEnabled?: boolean; answerUnregisteredGroups?: boolean; commandQuotaPerDay?: number
    contextTurns?: number; contextIdleMinutes?: number; typingFeedback?: boolean
  } | null>(null)
  const [calendarId, setCalendarId] = useState<string | null>(null)
  const [calMsg, setCalMsg] = useState('')
  const [calBusy, setCalBusy] = useState(false)
  const [result, setResult] = useState('')
  useEffect(() => {
    void (async () => {
      const s = await api.settings()
      setCfg((s['im.feishu'] as typeof cfg) || { appId: '', appSecret: '' })
      setCalendarId((s['calendar'] as { feishuCalendarId?: string })?.feishuCalendarId || '')
    })()
  }, [])
  if (!cfg) return <Spinner />
  const runCal = async (kind: 'init' | 'sync') => {
    setCalBusy(true); setCalMsg('')
    try {
      if (kind === 'init') {
        const r = await api.calendarInit()
        if (r.ok === false) { // v0.21：上游失败 200+reason（网关会替换 5xx 响应体），直接显示原因
          setCalMsg(`❌ ${r.reason}`)
          toast(r.reason || '项目日历初始化失败', 'bad')
          return
        }
        setCalendarId(r.calendarId)
        setCalMsg(`✅ 项目日历已创建（${r.calendarId}）。团队成员在飞书日历搜索「项目日历（gb-pmo）」即可订阅。`)
      } else {
        const r = await api.calendarSync()
        if ('reason' in r) {
          setCalMsg(`⏭️ ${r.reason}`)
        } else {
          const errs = r.errors?.length ? `；${r.errors.length} 个项目失败（${r.errors[0].name}: ${r.errors[0].error}）` : ''
          setCalMsg(`✅ 同步完成：新建 ${r.created} · 更新 ${r.updated} · 跳过 ${r.skipped}${errs}`)
          if (errs) toast(r.errors![0].error, 'bad')
        }
      }
    } catch (e) {
      setCalMsg(`❌ ${(e as Error).message}`)
      toast((e as Error).message, 'bad')
    } finally {
      setCalBusy(false)
    }
  }
  return (
    <div className="space-y-4">
      <Card title="飞书（自建应用 + 机器人进群 + im:message.group_msg；申请步骤见 docs/prd.md 附录 A.1）">
        <div className="max-w-lg">
          <Field label="App ID"><input className={inputCls} value={cfg.appId} onChange={(e) => setCfg({ ...cfg, appId: e.target.value })} /></Field>
          <Field label="App Secret"><input className={inputCls} type="password" value={cfg.appSecret} onChange={(e) => setCfg({ ...cfg, appSecret: e.target.value })} /></Field>
        </div>
        <div className="mb-2 flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px]">
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={!!cfg.botEnabled} onChange={(e) => setCfg({ ...cfg, botEnabled: e.target.checked })} />
            机器人指令通道（私聊/群@）
          </label>
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={cfg.answerUnregisteredGroups !== false} onChange={(e) => setCfg({ ...cfg, answerUnregisteredGroups: e.target.checked })} />
            未登记群也响应问答
          </label>
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={cfg.typingFeedback !== false} onChange={(e) => setCfg({ ...cfg, typingFeedback: e.target.checked })} />
            私聊「处理中」占位反馈
          </label>
          <label className="flex items-center gap-1.5">
            每成员每日指令限额
            <input
              type="number" min={0} className="w-20 rounded-md border border-[var(--color-line)] px-2 py-1 text-[13px] outline-none focus:border-[var(--color-brand)]"
              value={cfg.commandQuotaPerDay ?? 50} onChange={(e) => setCfg({ ...cfg, commandQuotaPerDay: Math.max(0, Number(e.target.value) || 0) })}
            />
          </label>
          <label className="flex items-center gap-1.5">
            多轮记忆条数
            <input
              type="number" min={0} max={24} className="w-16 rounded-md border border-[var(--color-line)] px-2 py-1 text-[13px] outline-none focus:border-[var(--color-brand)]"
              value={cfg.contextTurns ?? 8} onChange={(e) => setCfg({ ...cfg, contextTurns: Math.min(24, Math.max(0, Number(e.target.value) || 0)) })}
            />
          </label>
          <label className="flex items-center gap-1.5">
            空闲开新话题（分钟）
            <input
              type="number" min={1} max={1440} className="w-20 rounded-md border border-[var(--color-line)] px-2 py-1 text-[13px] outline-none focus:border-[var(--color-brand)]"
              value={cfg.contextIdleMinutes ?? 120} onChange={(e) => setCfg({ ...cfg, contextIdleMinutes: Math.max(1, Number(e.target.value) || 120) })}
            />
          </label>
        </div>
        <p className="mb-3 text-[12px] leading-5 text-[var(--color-ink-soft)]">
          机器人开关与限额「保存即热生效」：长连接立即建立或断开，无需重启进程（S20-12）；「多轮记忆条数」= 机器人记住的本会话最近消息数（0 = 关闭记忆，用户随时可发 /new 清空）；「空闲开新话题」= 超过该时长未说话自动遗忘此前对话；「私聊占位反馈」= 私聊自然语言指令先回「收到，正在处理…」、答案就绪后原地替换同一条消息（需应用开通 im:message:update 权限，缺权限时自动降级为另发一条，S20-19）。开启前需完成应用侧配置（机器人能力 + 长连接事件订阅，附录 A.1 第 7 步），可先点「测试连接」验证。
        </p>
        <div className="flex items-center gap-2">
          <Btn kind="primary" onClick={async () => {
            const r = await api.putSetting('im.feishu', cfg) as { bot?: { started: boolean; reason?: string } }
            toast('飞书配置已保存')
            setResult(r.bot ? (r.bot.started ? '✅ 已保存，机器人长连接已建立' : `已保存；机器人未连接——${r.bot.reason}`) : '')
          }}>保存</Btn>
          <Btn onClick={async () => { const r = await api.testIm('feishu'); setResult(r.ok ? '✅ 连接成功' : `❌ ${r.reason}`); if (!r.ok) toast(r.reason || '连接失败', 'bad') }}>测试连接</Btn>
          {result && <span className="text-[12px]">{result}</span>}
        </div>
      </Card>
      <Card title="项目日历（S22）：组织级日历，团队订阅即见全部项目起止（结项项目保留）">
        <p className="mb-3 text-[12px] leading-5 text-[var(--color-ink-soft)]">
          需先开通日历权限 <code>calendar:calendar</code> / <code>calendar:event</code>（附录 A.1 第 8 步）。
          初始化 = 应用身份创建组织内可订阅的日历；之后按「阈值与推送」的 calendarSyncCron 对账同步（改期/结项下轮自动跟进），此处可手动立即同步。
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[12px] text-[var(--color-ink-soft)]">
            状态：{calendarId ? <span className="num">已初始化（{calendarId}）</span> : '未初始化（调度静默跳过）'}
          </span>
          <Btn kind="primary" disabled={calBusy || !!calendarId} onClick={() => void runCal('init')}>初始化项目日历</Btn>
          <Btn disabled={calBusy || !calendarId} onClick={() => void runCal('sync')}>立即同步</Btn>
          {calBusy && <span className="text-[12px] text-[var(--color-ink-soft)]">请求飞书中…</span>}
        </div>
        {calMsg && <div className="mt-2 text-[12px]">{calMsg}</div>}
      </Card>
    </div>
  )
}

function WecomCard() {
  const { toast } = useStore()
  const [cfg, setCfg] = useState<{ corpId: string; secret: string; publicKeyVer: string; privateKey: string; sdkUrl: string } | null>(null)
  const [result, setResult] = useState('')
  useEffect(() => {
    void (async () => {
      const s = await api.settings()
      setCfg((s['im.wecom'] as typeof cfg) || { corpId: '', secret: '', publicKeyVer: '', privateKey: '', sdkUrl: '' })
    })()
  }, [])
  if (!cfg) return <Spinner />
  return (
    <Card title="企业微信（会话存档：付费开通 + RSA 公钥 + 官方 C SDK 代理；部署见附录 A.2）">
      <div className="max-w-2xl">
        <Field label="Corp ID"><input className={inputCls} value={cfg.corpId} onChange={(e) => setCfg({ ...cfg, corpId: e.target.value })} /></Field>
        <Field label="会话存档 Secret"><input className={inputCls} type="password" value={cfg.secret} onChange={(e) => setCfg({ ...cfg, secret: e.target.value })} /></Field>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Field label="公钥版本"><input className={inputCls} value={cfg.publicKeyVer} onChange={(e) => setCfg({ ...cfg, publicKeyVer: e.target.value })} /></Field>
          <Field label="SDK 代理地址"><input className={inputCls} placeholder="http://…/（未部署见附录 A.2）" value={cfg.sdkUrl} onChange={(e) => setCfg({ ...cfg, sdkUrl: e.target.value })} /></Field>
        </div>
        <Field label="RSA 私钥（PEM）"><textarea className={inputCls} rows={4} value={cfg.privateKey} onChange={(e) => setCfg({ ...cfg, privateKey: e.target.value })} /></Field>
      </div>
      <div className="flex items-center gap-2">
        <Btn kind="primary" onClick={async () => { await api.putSetting('im.wecom', cfg); toast('企微配置已保存') }}>保存</Btn>
        <Btn onClick={async () => { const r = await api.testIm('wecom'); setResult(r.ok ? '✅ 连接成功' : `❌ ${r.reason}`); if (!r.ok) toast(r.reason || '连接失败', 'bad') }}>测试连接（S17-5）</Btn>
        {result && <span className="text-[12px]">{result}</span>}
      </div>
    </Card>
  )
}
