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
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
        {toasts.map((t) => (
          <div key={t.id} className={`pop-in rounded-md px-3 py-2 text-[13px] shadow-md ${t.kind === 'bad' ? 'bg-[var(--color-bad)] text-white' : 'bg-[var(--color-ink)] text-white'}`}>
            {t.msg}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  )
}
