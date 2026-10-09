import { useEffect, useState, type HTMLAttributes, type ReactNode } from 'react'
import type { Tone } from '../types'

// 手写极简组件层（tech-architecture：不用组件库）
export function Btn({ children, onClick, kind = 'default', disabled, small, title }: {
  children: ReactNode; onClick?: () => void; kind?: 'default' | 'primary' | 'danger' | 'ghost'
  disabled?: boolean; small?: boolean; title?: string
}) {
  const base = `rounded-md font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${small ? 'px-2 py-0.5 text-[12px]' : 'px-3 py-1.5 text-[13px]'}`
  const styles = {
    default: 'bg-white border border-[var(--color-line)] hover:border-[var(--color-brand)]',
    primary: 'bg-[var(--color-brand)] text-white hover:brightness-110',
    danger: 'bg-[var(--color-bad)] text-white hover:brightness-110',
    ghost: 'text-[var(--color-brand)] hover:bg-[var(--color-brand-soft)]',
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
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-4 fade-in" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`pop-in max-h-[88dvh] w-full overflow-auto rounded-lg bg-[var(--color-card)] shadow-xl ${wide ? 'max-w-3xl' : 'max-w-md'}`}>
        <div className="flex items-center justify-between border-b border-[var(--color-line)] px-4 py-3">
          <div className="font-semibold">{title}</div>
          <button className="text-[var(--color-ink-soft)] hover:text-[var(--color-ink)]" onClick={onClose}>✕</button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  )
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="mb-3 block">
      <div className="mb-1 text-[12px] text-[var(--color-ink-soft)]">{label}</div>
      {children}
    </label>
  )
}

export const inputCls = 'w-full rounded-md border border-[var(--color-line)] px-2.5 py-1.5 text-[13px] outline-none focus:border-[var(--color-brand)]'

export function Spinner() {
  return <div className="flex h-40 items-center justify-center text-[var(--color-ink-soft)]">加载中…</div>
}

// S41/K23：Tone→底色的映射在组件层唯一（Badge 与 InlineSelect 共用）
const TONE_CLS: Record<Tone, string> = {
  ok: 'bg-green-50 text-[var(--color-ok)]', warn: 'bg-amber-50 text-[var(--color-warn)]',
  bad: 'bg-red-50 text-[var(--color-bad)]', info: 'bg-[var(--color-brand-soft)] text-[var(--color-brand)]',
  muted: 'bg-gray-100 text-[var(--color-ink-soft)]',
}

export function Badge({ tone, children, ...rest }: { tone: Tone; children: ReactNode } & HTMLAttributes<HTMLSpanElement>) {
  return <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium ${TONE_CLS[tone]}`} {...rest}>{children}</span>
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
      <span className={`cursor-text rounded px-1 hover:bg-[var(--color-brand-soft)] ${className || ''}`} onClick={() => setEditing(true)}>
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
      className={`cursor-pointer rounded px-1 py-0.5 text-[13px] outline-none ${tone ? TONE_CLS[tone] : 'bg-transparent hover:bg-[var(--color-brand-soft)]'}`}
      value={value} onChange={(e) => onSubmit(e.target.value)}
    >
      {Object.entries(options).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  )
}

export function Card({ title, children, actions }: { title?: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="rounded-lg border border-[var(--color-line)] bg-[var(--color-card)]">
      {(title || actions) && (
        <header className="flex items-center justify-between border-b border-[var(--color-line)] px-4 py-2.5">
          <div className="text-[13px] font-semibold">{title}</div>
          <div className="flex items-center gap-2">{actions}</div>
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  )
}

export function Empty({ hint }: { hint: string }) {
  return <div className="py-10 text-center text-[13px] text-[var(--color-ink-soft)]">{hint}</div>
}

/** Tab 条（配置台每页内部分区；无路由库，选中态由调用方管理） */
export function Tabs({ tabs, value, onChange }: {
  tabs: { key: string; label: string }[]; value: string; onChange: (key: string) => void
}) {
  return (
    <div className="mb-4 flex flex-wrap gap-1 border-b border-[var(--color-line)]">
      {tabs.map((t) => (
        <button
          key={t.key} type="button"
          className={`-mb-px border-b-2 px-3 py-2 text-[13px] transition-colors ${
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
