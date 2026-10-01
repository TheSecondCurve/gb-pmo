import { useEffect, useState } from 'react'
import { api } from '../../api'
import { useStore } from '../../store'
import { Badge, Btn, Card, Field, Spinner, Tabs, inputCls } from '../../components/ui'
import { ADMIN_SECTIONS } from './sections'

const TABS = ADMIN_SECTIONS[3].tabs

// S26（v0.19）运维诊断：Docker/PaaS 容器不可 exec 的排障入口。
// 诊断 shell 等价把容器执行权交给管理员账号——开关默认关、全程审计，用完建议关闭。
export default function OpsAdmin({ tab }: { tab: string }) {
  const nav = (key: string) => { location.hash = `#/admin/ops/${key}` }
  return (
    <div>
      <Tabs tabs={TABS} value={tab} onChange={nav} />
      {tab === 'shell' && <ShellCard />}
      {tab === 'selfcheck' && <FeishuCheckCard />}
    </div>
  )
}

interface DebugCfg { shellEnabled: boolean; timeoutMs: number; maxOutputBytes: number }
interface ShellResult { stdout: string; stderr: string; code: number; timedOut: boolean; truncated: boolean; durationMs: number }

function ShellCard() {
  const { toast } = useStore()
  const [cfg, setCfg] = useState<DebugCfg | null>(null)
  const [command, setCommand] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ShellResult | null>(null)
  const [err, setErr] = useState('')
  useEffect(() => {
    void (async () => setCfg((await api.settings())['debug'] as DebugCfg))()
  }, [])
  if (!cfg) return <Spinner />
  const save = async (patch: Partial<DebugCfg>) => {
    const next = { ...cfg, ...patch }
    await api.putSetting('debug', next)
    setCfg(next)
    toast(`已保存：shell ${next.shellEnabled ? '开启' : '关闭'}`)
  }
  const run = async () => {
    if (!command.trim()) return
    setBusy(true); setErr(''); setResult(null)
    try {
      setResult(await api.debugShell(command))
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="space-y-4">
      <Card title="诊断 Shell（S26）：在容器内执行 /bin/sh 命令排障；每次执行入审计日志（含命令与退出码）">
        <p className="mb-3 text-[12px] leading-5 text-[var(--color-ink-soft)]">
          安全边界：等价于把容器执行权交给管理员账号——仅系统管理员可用、开关默认关、仅限可信内网排障。<b>用完请关闭开关。</b>
          超时（当前 {cfg.timeoutMs}ms）与输出截断（当前 {Math.round(cfg.maxOutputBytes / 1024)}KB）可在「阈值与推送」之外的 debug 配置调整（下方直接改）。
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px]">shell 开关：</span>
          <Btn kind={cfg.shellEnabled ? 'primary' : 'default'} onClick={() => void save({ shellEnabled: !cfg.shellEnabled })}>
            {cfg.shellEnabled ? '已开启（点击关闭）' : '已关闭（点击开启）'}
          </Btn>
          <Field label="超时 ms（1000~60000）">
            <input className={`${inputCls} w-36`} type="number" value={cfg.timeoutMs}
              onChange={(e) => setCfg({ ...cfg, timeoutMs: Number(e.target.value) })} onBlur={() => void save({})} />
          </Field>
          <Field label="输出上限字节（1024~1048576）">
            <input className={`${inputCls} w-40`} type="number" value={cfg.maxOutputBytes}
              onChange={(e) => setCfg({ ...cfg, maxOutputBytes: Number(e.target.value) })} onBlur={() => void save({})} />
          </Field>
        </div>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-start">
          <input
            className={`${inputCls} font-mono`} placeholder="如：ps aux | head -20；env | grep -i feishu；wget -qO- https://open.feishu.cn -S 2>&1 | head -5"
            value={command} disabled={!cfg.shellEnabled || busy}
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && cfg.shellEnabled && !busy) void run() }}
          />
          <Btn kind="primary" disabled={!cfg.shellEnabled || busy || !command.trim()} onClick={() => void run()}>
            {busy ? '执行中…' : '执行'}
          </Btn>
        </div>
        {!cfg.shellEnabled && <p className="mt-2 text-[12px] text-[var(--color-warn, #b45309)]">开关关闭时执行会被拒绝（400）——先开启上方开关。</p>}
        {err && <p className="mt-2 text-[12px] text-[var(--color-bad, #b91c1c)]">❌ {err}</p>}
        {result && (
          <div className="mt-3 space-y-2">
            <div className="flex flex-wrap items-center gap-2 text-[12px]">
              <Badge tone={result.code === 0 ? 'ok' : 'bad'}>退出码 {result.code}</Badge>
              <span className="num">{result.durationMs}ms</span>
              {result.timedOut && <Badge tone="warn">超时终止</Badge>}
              {result.truncated && <Badge tone="warn">输出已截断</Badge>}
            </div>
            {result.stdout && <pre className="max-h-72 overflow-auto rounded-md bg-[var(--color-bg)] p-2 text-[12px] leading-5">{result.stdout}</pre>}
            {result.stderr && <pre className="max-h-40 overflow-auto rounded-md bg-[var(--color-bg)] p-2 text-[12px] leading-5 text-[var(--color-bad, #b91c1c)]">{result.stderr}</pre>}
          </div>
        )}
      </Card>
    </div>
  )
}

interface SelfcheckStage { stage: string; ok: boolean; reason?: string; note?: string }

function FeishuCheckCard() {
  const [busy, setBusy] = useState(false)
  const [stages, setStages] = useState<SelfcheckStage[] | null>(null)
  const [ok, setOk] = useState<boolean | null>(null)
  const run = async () => {
    setBusy(true)
    try {
      const r = await api.feishuSelfcheck()
      setStages(r.stages); setOk(r.ok)
    } finally {
      setBusy(false)
    }
  }
  const stageLabel: Record<string, string> = {
    token: '① 凭证与网络（tenant_access_token）',
    ws: '② 长连接握手（WSClient）',
  }
  return (
    <Card title="飞书长连接自检（S26）：三段定位「机器人不应答」断点；复用「外部依赖→飞书」已存凭证">
      <p className="mb-3 text-[12px] leading-5 text-[var(--color-ink-soft)]">
        ①凭证与网络 → ②长连接握手（官方 SDK，快速失败）→ ③收消息为人工段（通过①②后按提示清单在开发者后台核对，
        或私聊机器人发一句话验证）。此检查不需要开启诊断 shell 开关。
      </p>
      <Btn kind="primary" disabled={busy} onClick={() => void run()}>{busy ? '自检中…' : '运行自检'}</Btn>
      {stages && (
        <div className="mt-3 space-y-2">
          {stages.map((s) => (
            <div key={s.stage} className="rounded-md border border-[var(--color-line)] p-2 text-[12px] leading-5">
              <div className="flex items-center gap-2">
                <b>{stageLabel[s.stage] || s.stage}</b>
                <Badge tone={s.ok ? 'ok' : 'bad'}>{s.ok ? '通过' : '失败'}</Badge>
              </div>
              {s.reason && <p className="mt-1 text-[var(--color-bad, #b91c1c)]">{s.reason}</p>}
              {s.note && <p className="mt-1 text-[var(--color-ink-soft)]">{s.note}</p>}
            </div>
          ))}
          <p className="text-[12px]">{ok ? '✅ 自动段全部通过' : '❌ 在失败段按提示处理后重新自检'}</p>
        </div>
      )}
    </Card>
  )
}
