import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { api } from './api'

interface Store {
  member: { id: number; name: string; role: string } | null
  ready: boolean
  refresh: () => Promise<void>
  toast: (msg: string, kind?: 'ok' | 'bad') => void
}

const Ctx = createContext<Store>({ member: null, ready: false, refresh: async () => {}, toast: () => {} })
export const useStore = () => useContext(Ctx)

export function StoreProvider({ children }: { children: ReactNode }) {
  const [member, setMember] = useState<Store['member']>(null)
  const [ready, setReady] = useState(false)
  const [toasts, setToasts] = useState<{ id: number; msg: string; kind: 'ok' | 'bad' }[]>([])

  const toast = useCallback((msg: string, kind: 'ok' | 'bad' = 'ok') => {
    const id = Date.now() + Math.random()
    setToasts((t) => [...t, { id, msg, kind }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2600)
  }, [])

  const refresh = useCallback(async () => {
    try {
      const r = await api.me()
      setMember(r.member)
    } catch {
      setMember(null)
    } finally {
      setReady(true)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  return (
    <Ctx.Provider value={{ member, ready, refresh, toast }}>
      {children}
      <div className="fixed bottom-5 right-5 z-50 flex max-w-[min(24rem,calc(100vw-2.5rem))] flex-col gap-2">
        {toasts.map((t) => (
          <div key={t.id} className={`pop-in flex items-center gap-2.5 rounded-[4px] border px-4 py-3 text-[12px] leading-5 shadow-[var(--shadow-float)] ${t.kind === 'bad' ? 'border-[var(--color-bad)] bg-[var(--color-bad)] text-white' : 'border-[var(--color-ink)] bg-[var(--color-ink)] text-[var(--color-card)]'}`}>
            <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${t.kind === 'bad' ? 'bg-white/75' : 'bg-[#9db1ff]'}`} />
            <span>{t.msg}</span>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  )
}
