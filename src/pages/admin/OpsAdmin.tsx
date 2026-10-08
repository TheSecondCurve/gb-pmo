import { useEffect, useState } from 'react'
import { api } from '../../api'
import { useStore } from '../../store'
import { Badge, Btn, Card, Field, Spinner, Tabs, inputCls } from '../../components/ui'
import { fmtDateTime } from '../../fmt'
import { ADMIN_SECTIONS } from './sections'

const TABS = ADMIN_SECTIONS[3].tabs

// S26（v0.19）运维诊断：Docker/PaaS 容器不可 exec 的排障入口。
// 诊断 shell 等价把容器执行权交给管理员账号——开关默认关、全程审计，用完建议关闭。
// S34（v0.35）新增「数据库备份」Tab：S3 兼容对象存储（OSS/R2/MinIO）配置 + 定时异地备份。
export default function OpsAdmin({ tab }: { tab: string }) {
  const nav = (key: string) => { location.hash = `#/admin/ops/${key}` }
  return (
    <div>
      <Tabs tabs={TABS} value={tab} onChange={nav} />
      {tab === 'shell' && <ShellCard />}
      {tab === 'selfcheck' && <FeishuCheckCard />}
      {tab === 'backup' && <BackupCard />}
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

// —— S34（v0.35）数据库备份：S3 兼容存储配置（OSS/R2/MinIO 预设）+ 测试连通性 + 立即备份 + 历史 ——

interface BackupCfg {
  endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string
  prefix: string; pathStyle: boolean; keepCount: number
}
interface BackupHistoryRow { at: number; memberName: string; ok?: boolean; key?: string; bytes?: number; durationMs?: number; deleted?: number; error?: string; reason?: string }

function BackupCard() {
  const { toast } = useStore()
  const [cfg, setCfg] = useState<BackupCfg | null>(null)
  const [sched, setSched] = useState<{ backupCron: string; backupEnabled: boolean } | null>(null)
  const [history, setHistory] = useState<BackupHistoryRow[]>([])
  const [busy, setBusy] = useState<'' | 'test' | 'run'>('')
  const [testMsg, setTestMsg] = useState('')
  const [runMsg, setRunMsg] = useState('')
  useEffect(() => {
    void (async () => {
      const s = await api.settings()
      setCfg(s.backup as BackupCfg)
      setSched(s.scheduler as { backupCron: string; backupEnabled: boolean })
      setHistory((await api.backupHistory()).history)
    })()
  }, [])
  if (!cfg || !sched) return <Spinner />
  const preset = (p: 'oss' | 'r2' | 'minio') => setCfg({
    ...cfg,
    endpoint: p === 'oss' ? 'https://oss-cn-hangzhou.aliyuncs.com' : p === 'r2' ? 'https://<account-id>.r2.cloudflarestorage.com' : 'http://127.0.0.1:9000',
    region: p === 'r2' ? 'auto' : '',
    pathStyle: p === 'minio',
  })
  const test = async () => {
    setBusy('test'); setTestMsg('')
    try {
      const r = await api.testBackup(cfg)
      setTestMsg(r.ok ? `✅ 连接成功（HEAD 桶 / 写探针 / 清理，${r.durationMs}ms）` : `❌ ${r.reason}`)
      if (!r.ok) toast(r.reason || '连接失败', 'bad')
    } catch (e) {
      setTestMsg(`❌ ${(e as Error).message}`)
    } finally {
      setBusy('')
    }
  }
  const run = async () => {
    setBusy('run'); setRunMsg('')
    try {
      const r = await api.runBackup()
      if (r.ok) {
        setRunMsg(`✅ 已上传 ${r.key}（${Math.round((r.bytes ?? 0) / 1024)}KB · ${r.durationMs}ms${r.deleted ? ` · 清理旧备份 ${r.deleted} 份` : ''}）`)
        toast('备份完成')
      } else if (r.skipped) {
        setRunMsg(`⏭️ ${r.reason}`)
      } else {
        setRunMsg(`❌ ${r.reason}`)
        toast(r.reason || '备份失败', 'bad')
      }
      setHistory((await api.backupHistory()).history)
    } catch (e) {
      setRunMsg(`❌ ${(e as Error).message}`)
    } finally {
      setBusy('')
    }
  }
  return (
    <div className="space-y-4">
      <Card title="数据库异地备份（S34）：SQLite 在线快照 → gzip → S3 兼容对象存储（阿里云 OSS / Cloudflare R2 / AWS S3 / MinIO）">
        <p className="mb-3 text-[12px] leading-5 text-[var(--color-ink-soft)]">
          单机 SQLite 是全部数据的唯一载体，本地备份与容器同生共死；本页把定时快照推进对象存储实现异地容灾（本地 scripts/backup.sh 保留，两层叠加）。
          定时备份由「项目管理→阈值与推送」的 <b>数据库备份</b> cron 驱动（当前 <span className="num">{sched.backupCron}</span>，{sched.backupEnabled ? '已启用' : '已停用'}，保存即热生效）；
          存储未配全时定时/手动均跳过。备份对象名 <span className="num">gb-pmo-YYYYMMDD-HHMMSS.db.gz</span>（北京时刻），云端滚动保留最新 {cfg.keepCount} 份。
        </p>
        <div className="mb-2 flex flex-wrap items-center gap-2 text-[12px]">
          <span className="text-[var(--color-ink-soft)]">预设：</span>
          <Btn onClick={() => preset('oss')}>阿里云 OSS</Btn>
          <Btn onClick={() => preset('r2')}>Cloudflare R2</Btn>
          <Btn onClick={() => preset('minio')}>MinIO / 自建</Btn>
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <Field label="S3 兼容端点（endpoint）">
            <input className={inputCls + ' font-mono'} placeholder="https://oss-cn-hangzhou.aliyuncs.com" value={cfg.endpoint} onChange={(e) => setCfg({ ...cfg, endpoint: e.target.value })} />
          </Field>
          <Field label="Bucket">
            <input className={inputCls} value={cfg.bucket} onChange={(e) => setCfg({ ...cfg, bucket: e.target.value })} />
          </Field>
          <Field label="Region（留空按 endpoint 推断：R2=auto / OSS=地域前缀）">
            <input className={inputCls} placeholder="auto / oss-cn-hangzhou / us-east-1" value={cfg.region} onChange={(e) => setCfg({ ...cfg, region: e.target.value })} />
          </Field>
          <Field label="AccessKey ID">
            <input className={inputCls} value={cfg.accessKeyId} onChange={(e) => setCfg({ ...cfg, accessKeyId: e.target.value })} />
          </Field>
          <Field label="AccessKey Secret">
            <input className={inputCls} type="password" value={cfg.secretAccessKey} onChange={(e) => setCfg({ ...cfg, secretAccessKey: e.target.value })} />
          </Field>
          <Field label="对象前缀（空=桶根）">
            <input className={inputCls} value={cfg.prefix} onChange={(e) => setCfg({ ...cfg, prefix: e.target.value })} />
          </Field>
          <Field label="云端保留份数（1~365，超出删最旧）">
            <input className={`${inputCls} !w-36`} type="number" min={1} max={365} value={cfg.keepCount} onChange={(e) => setCfg({ ...cfg, keepCount: Number(e.target.value) })} />
          </Field>
          <label className="mb-3 flex items-center gap-1.5 pb-2 text-[13px]">
            <input type="checkbox" checked={cfg.pathStyle} onChange={(e) => setCfg({ ...cfg, pathStyle: e.target.checked })} />
            路径风格寻址（MinIO/自建需勾选；OSS/R2 不勾）
          </label>
        </div>
        <p className="mb-3 text-[12px] leading-5 text-[var(--color-ink-soft)]">
          桶应为<b>私有读写</b>、AccessKey 仅授该桶（备份含全库数据）；恢复 = 从桶里下载最近对象 → gunzip → 替换库文件重启（docs/standards/deployment.md）。
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Btn kind="primary" onClick={async () => {
            try {
              const r = await api.putSetting('backup', cfg) as { value: BackupCfg }
              setCfg(r.value); toast('备份存储配置已保存')
            } catch (e) { toast((e as Error).message, 'bad') }
          }}>保存</Btn>
          <Btn disabled={busy !== ''} onClick={() => void test()}>{busy === 'test' ? '测试中…' : '测试连接（当前表单值，可先测后存）'}</Btn>
          <Btn disabled={busy !== ''} onClick={() => void run()}>{busy === 'run' ? '备份中…' : '立即备份'}</Btn>
          {testMsg && <span className="text-[12px]">{testMsg}</span>}
          {runMsg && <span className="text-[12px]">{runMsg}</span>}
        </div>
      </Card>
      <Card title="最近备份（backup.run 审计最近 10 条；「调度器」= 定时触发）">
        {history.length === 0 ? (
          <p className="text-[12px] text-[var(--color-ink-soft)]">暂无备份记录——配置存储并「测试连接」通过后，下一个 cron 时点或手动「立即备份」会出现在这里。</p>
        ) : (
          <div className="space-y-1">
            {history.map((h, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2 text-[12px]">
                <Badge tone={h.ok ? 'ok' : 'bad'}>{h.ok ? '成功' : '失败'}</Badge>
                <span className="num">{fmtDateTime(h.at)}</span>
                <span>{h.memberName}</span>
                {h.key && <span className="num">{h.key}</span>}
                {h.bytes != null && <span className="num">{Math.round(h.bytes / 1024)}KB · {h.durationMs}ms</span>}
                {h.deleted ? <span>清理旧备份 {h.deleted} 份</span> : null}
                {(h.error || h.reason) && <span className="text-[var(--color-bad, #b91c1c)]">{h.error || h.reason}</span>}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}

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
