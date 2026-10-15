import type { ReactNode } from 'react'

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <div className={`${compact ? 'h-8 w-8 rounded-[3px] text-[17px]' : 'h-10 w-10 rounded-[4px] text-[20px]'} relative flex shrink-0 items-center justify-center bg-[var(--color-ink)] text-[var(--color-card)]`}>
        <span className="display-type -translate-y-px">项</span>
        <span aria-hidden="true" className="absolute bottom-1.5 right-1.5 h-1 w-1 rounded-full bg-[#8fa2ff]" />
      </div>
      <div>
        <div className={`${compact ? 'text-[17px]' : 'text-[19px]'} display-type leading-none text-[var(--color-ink)]`}>项目大脑</div>
        <div className="mt-1.5 text-[8px] font-semibold tracking-[0.24em] text-[var(--color-ink-soft)]">PROJECT BRAIN</div>
      </div>
    </div>
  )
}

export function PageMasthead({ kicker, title, description, aside, actions, testId }: {
  kicker: string
  title: ReactNode
  description?: ReactNode
  aside?: ReactNode
  actions?: ReactNode
  testId?: string
}) {
  return (
    <header data-testid={testId} className="editorial-enter flex flex-col gap-6 border-t border-[var(--color-ink)] pt-3 xl:flex-row xl:items-end xl:justify-between">
      <div className="min-w-0 max-w-3xl">
        <div className="editorial-kicker">{kicker}</div>
        <h1 className="display-type mt-3 text-[38px] leading-[1.12] text-[var(--color-ink)] md:text-[46px]">{title}</h1>
        {description && <div className="mt-3 max-w-2xl text-[13px] leading-6 text-[var(--color-ink-soft)]">{description}</div>}
      </div>
      {(aside || actions) && (
        <div className="flex shrink-0 flex-col items-start gap-4 xl:items-end">
          {aside}
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
    </header>
  )
}

export function SectionHeading({ index, title, aside }: { index: string; title: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-4 flex items-end justify-between gap-4 border-b border-[var(--color-ink)] pb-3">
      <div className="flex items-baseline gap-3">
        <span className="num text-[10px] font-semibold tracking-[0.16em] text-[var(--color-brand)]">{index}</span>
        <h2 className="display-type text-[22px] leading-tight">{title}</h2>
      </div>
      {aside && <div className="text-[11px] text-[var(--color-ink-soft)]">{aside}</div>}
    </div>
  )
}
