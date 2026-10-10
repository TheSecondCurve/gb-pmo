// S46（v0.51，K29）通知收件箱：本人推送记录（日报/预警/梳理/建议通知）。
// IM 未配置时投递状态为「未投递」，内容仍可读（推送=落库 + 尽力投递）。
import { useEffect, useState } from 'react'
import { api } from '../api'
import { Badge, Card, Empty, Spinner } from '../components/ui'
import { fmtDateTime } from '../fmt'
import type { PushRow } from '../types'

const PUSH_TYPE_LABEL: Record<string, string> = {
  daily_report: '日报', digest: '梳理/建议', alert: '预警', test: '测试',
}
const PUSH_STATUS: Record<string, { label: string; tone: 'ok' | 'bad' | 'muted' }> = {
  sent: { label: '已送达', tone: 'ok' },
  failed: { label: '投递失败', tone: 'bad' },
  skipped: { label: '未投递', tone: 'muted' },
}

export default function Pushes() {
  const [pushes, setPushes] = useState<PushRow[] | null>(null)
  useEffect(() => {
    void (async () => setPushes((await api.pushes()).pushes))()
  }, [])

  if (!pushes) return <Spinner />

  return (
    <div className="space-y-3">
      <h1 className="text-lg font-bold">
        通知 <span className="text-[12px] font-normal text-[var(--color-ink-soft)]">日报 / 预警 / 梳理与建议通知 · 仅本人可见</span>
      </h1>
      {pushes.length === 0 ? (
        <Card><Empty hint="暂无推送记录——日报/预警/梳理产出后会出现在这里" /></Card>
      ) : (
        pushes.map((p) => {
          const st = PUSH_STATUS[p.status] ?? { label: p.status, tone: 'muted' as const }
          return (
            <Card key={p.id}>
              <div className="mb-1 flex items-center gap-2 text-[12px] text-[var(--color-ink-soft)]">
                <Badge tone="info">{PUSH_TYPE_LABEL[p.pushType] ?? p.pushType}</Badge>
                <Badge tone={st.tone}>{st.label}</Badge>
                <span>{fmtDateTime(p.createdAt)}</span>
                {p.error && <span className="truncate" title={p.error}>（{p.error}）</span>}
              </div>
              <div className="text-[14px] font-medium">{p.title}</div>
              <pre className="mt-1 whitespace-pre-wrap break-words font-[inherit] text-[13px] leading-5 text-[var(--color-ink)]">{p.body}</pre>
            </Card>
          )
        })
      )}
    </div>
  )
}
