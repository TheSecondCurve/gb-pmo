// S46（v0.51，K29）通知收件箱：本人推送记录（日报/预警/梳理/建议通知）。
// IM 未配置时投递状态为「未投递」，内容仍可读（推送=落库 + 尽力投递）。
import { useEffect, useState } from 'react'
import { api } from '../api'
import { Badge, Card, Empty, Spinner } from '../components/ui'
import { PageMasthead } from '../components/editorial'
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
    <div className="space-y-9">
      <PageMasthead
        kicker="Inbox / 04"
        title="通知"
        description="日报、预警、梳理与建议通知，按时间收进同一份收件记录。这里的内容仅本人可见。"
        aside={<div className="num text-[11px] text-[var(--color-ink-soft)]">{pushes.length} 条记录</div>}
      />
      {pushes.length === 0 ? (
        <Card><Empty hint="暂无推送记录——日报/预警/梳理产出后会出现在这里" /></Card>
      ) : (
        <div className="editorial-enter-late border-t border-[var(--color-ink)]">
          {pushes.map((p) => {
            const st = PUSH_STATUS[p.status] ?? { label: p.status, tone: 'muted' as const }
            return (
              <article key={p.id} className="border-b border-[var(--color-line)] py-6 md:py-7">
                <div className="mb-3 flex flex-wrap items-center gap-2 text-[11px] text-[var(--color-ink-soft)]">
                  <Badge tone="info">{PUSH_TYPE_LABEL[p.pushType] ?? p.pushType}</Badge>
                  <Badge tone={st.tone}>{st.label}</Badge>
                  <span className="num">{fmtDateTime(p.createdAt)}</span>
                  {p.error && <span className="truncate" title={p.error}>（{p.error}）</span>}
                </div>
                <h2 className="display-type text-[20px] font-semibold leading-7">{p.title}</h2>
                <pre className="mt-3 max-w-[760px] whitespace-pre-wrap break-words font-[inherit] text-[13px] leading-6 text-[var(--color-ink-soft)]">{p.body}</pre>
              </article>
            )
          })}
        </div>
      )}
    </div>
  )
}
