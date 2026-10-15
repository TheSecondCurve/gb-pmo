import { useEffect, useState, type HTMLAttributes, type ReactNode } from 'react'
import type { Tone } from '../types'

// 手写极简组件层（tech-architecture：不用组件库）
export function Btn({ children, onClick, kind = 'default', disabled, small, title }: {
  children: ReactNode; onClick?: () => void; kind?: 'default' | 'primary' | 'danger' | 'ghost'
  disabled?: boolean; small?: boolean; title?: string
}) {
  const base = `inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-full font-medium transition-[color,background-color,border-color,box-shadow,transform] duration-150 disabled:cursor-not-allowed disabled:opacity-45 ${small ? 'min-h-7 px-3 py-1 text-[12px]' : 'min-h-9 px-4 py-2 text-[13px]'}`
  const styles = {
    default: 'border border-[var(--color-line-strong)] bg-[var(--color-card)] hover:-translate-y-px hover:border-[var(--color-ink-soft)] hover:shadow-[0_3px_10px_rgb(32_35_31/0.06)]',
    primary: 'border border-[var(--color-brand)] bg-[var(--color-brand)] text-white shadow-[0_4px_14px_rgb(52_79_196/0.16)] hover:-translate-y-px hover:bg-[var(--color-brand-deep)]',
    danger: 'border border-[var(--color-bad)] bg-[var(--color-bad-soft)] text-[var(--color-bad)] hover:-translate-y-px hover:bg-[var(--color-bad)] hover:text-white',
    ghost: 'border border-transparent text-[var(--color-brand)] hover:bg-[var(--color-brand-soft)]',
  }[kind]
  return (
    <button type="button" title={title} className={`${base} ${styles}`} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  )
}

export function Modal({ title, children, onClose, wide }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-[#171914]/45 p-4 backdrop-blur-[2px] fade-in" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`pop-in max-h-[88dvh] w-full overflow-auto rounded-[6px] border border-[var(--color-line)] bg-[var(--color-card)] shadow-[var(--shadow-editorial)] ${wide ? 'max-w-3xl' : 'max-w-md'}`}>
        <div className="flex items-center justify-between gap-4 border-b border-[var(--color-line)] px-5 py-4 md:px-6">
          <div className="display-type text-[19px] font-semibold">{title}</div>
          <button className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[var(--color-ink-soft)] transition-colors hover:bg-[var(--color-panel)] hover:text-[var(--color-ink)]" onClick={onClose}>✕</button>
        </div>
        <div className="p-5 md:p-6">{children}</div>
      </div>
    </div>
  )
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="mb-4 block">
      <div className="mb-1.5 text-[11px] font-medium leading-5 text-[var(--color-ink-soft)]">{label}</div>
      {children}
    </label>
  )
}

export const inputCls = 'w-full min-w-0 rounded-[3px] border border-[var(--color-line-strong)] bg-[var(--color-card)] px-3 py-2 text-[13px] text-[var(--color-ink)] outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-[var(--color-ink-faint)] focus:border-[var(--color-brand)] focus:shadow-[0_0_0_3px_var(--color-brand-soft)]'

export function Spinner() {
  return <div className="flex h-40 items-center justify-center text-[12px] tracking-[0.12em] text-[var(--color-ink-soft)]">加载中…</div>
}

// S41/K23：Tone→底色的映射在组件层唯一（Badge 与 InlineSelect 共用）
const TONE_CLS: Record<Tone, string> = {
  ok: 'bg-[var(--color-ok-soft)] text-[var(--color-ok)]',
  warn: 'bg-[var(--color-warn-soft)] text-[var(--color-warn)]',
  bad: 'bg-[var(--color-bad-soft)] text-[var(--color-bad)]',
  info: 'bg-[var(--color-brand-soft)] text-[var(--color-brand)]',
  muted: 'bg-[var(--color-panel)] text-[var(--color-ink-soft)]',
}

export function Badge({ tone, children, ...rest }: { tone: Tone; children: ReactNode } & HTMLAttributes<HTMLSpanElement>) {
  return <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-semibold leading-4 ${TONE_CLS[tone]}`} {...rest}>{children}</span>
}

/** 就地编辑：点击变输入框，Enter/blur 提交，Esc 取消（YNAB 式交互 §1/§4） */
export function InlineText({ value, onSubmit, className, type = 'text', placeholder }: {
  value?: string | number | null; onSubmit: (v: string) => void; className?: string; type?: string; placeholder?: string
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(String(value ?? ''))
  useEffect(() => setDraft(String(value ?? '')), [value])
  if (!editing) {
    return (
      <span className={`cursor-text rounded-[3px] px-1 transition-colors hover:bg-[var(--color-brand-soft)] ${className || ''}`} onClick={() => setEditing(true)}>
        {value === null || value === '' ? <span className="text-[var(--color-ink-soft)]">{placeholder || '—'}</span> : value}
      </span>
    )
  }
  return (
    <input
      autoFocus type={type} className={`cell-input num ${className || ''}`} value={draft} placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => { setEditing(false); if (draft !== String(value ?? '')) onSubmit(draft) }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { setEditing(false); if (draft !== String(value ?? '')) onSubmit(draft) }
        if (e.key === 'Escape') setEditing(false)
      }}
    />
  )
}

/** 就地下拉：状态/优先级档位快速改；S41 起可传 tones 按当前值着色（色彩语义表在 types.ts，K23） */
export function InlineSelect({ value, options, onSubmit, tones }: {
  value: string; options: Record<string, string>; onSubmit: (v: string) => void; tones?: Record<string, Tone>
}) {
  const tone = tones?.[value]
  return (
    <select
      data-tone={tone}
      className={`cursor-pointer rounded-full px-2 py-1 text-[12px] font-medium outline-none transition-colors ${tone ? TONE_CLS[tone] : 'bg-transparent hover:bg-[var(--color-brand-soft)]'}`}
      value={value} onChange={(e) => onSubmit(e.target.value)}
    >
      {Object.entries(options).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  )
}

export function Card({ title, children, actions }: { title?: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="rounded-[5px] border border-[var(--color-line)] bg-[var(--color-card)]">
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-line)] px-5 py-3.5 md:px-6">
          <div className="text-[14px] font-semibold tracking-[-0.01em]">{title}</div>
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
        </header>
      )}
      <div className="p-5 md:p-6">{children}</div>
    </section>
  )
}

export function Empty({ hint }: { hint: string }) {
  return (
    <div className="flex min-h-28 flex-col items-center justify-center gap-2 py-8 text-center text-[13px] text-[var(--color-ink-soft)]">
      <span aria-hidden="true" className="mb-1 block h-px w-8 bg-[var(--color-line-strong)]" />
      <span>{hint}</span>
    </div>
  )
}

/** Tab 条（配置台每页内部分区；无路由库，选中态由调用方管理） */
export function Tabs({ tabs, value, onChange }: {
  tabs: { key: string; label: string }[]; value: string; onChange: (key: string) => void
}) {
  return (
    <div className="mb-5 flex flex-wrap gap-1 border-b border-[var(--color-line)]">
      {tabs.map((t) => (
        <button
          key={t.key} type="button"
          className={`-mb-px border-b px-4 py-2.5 text-[13px] transition-colors duration-150 ${
            value === t.key
              ? 'border-[var(--color-brand)] font-medium text-[var(--color-brand)]'
              : 'border-transparent text-[var(--color-ink-soft)] hover:text-[var(--color-ink)]'
          }`}
          onClick={() => onChange(t.key)}
        >{t.label}</button>
      ))}
    </div>
  )
}
