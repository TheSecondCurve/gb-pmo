import { useState } from 'react'
import { api } from '../api'
import { Btn, Field, inputCls } from '../components/ui'

export default function Login({ onLogin }: { onLogin: () => Promise<void> }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    setBusy(true); setErr('')
    try {
      await api.login(username, password)
      await onLogin()
      location.hash = '#/dashboard'
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full items-center justify-center p-4">
      <div className="w-full max-w-[20rem] rounded-lg border border-[var(--color-line)] bg-[var(--color-card)] p-6 pop-in">
        <div className="mb-1 text-lg font-bold">🧠 项目大脑</div>
        <div className="mb-4 text-[12px] text-[var(--color-ink-soft)]">企业多项目管理 · LLM 大脑 · 全员透明</div>
        <Field label="用户名">
          <input className={inputCls} value={username} autoFocus onChange={(e) => setUsername(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()} />
        </Field>
        <Field label="密码">
          <input className={inputCls} type="password" value={password} onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()} />
        </Field>
        {err && <div className="mb-3 rounded bg-red-50 px-2 py-1.5 text-[12px] text-[var(--color-bad)]">{err}</div>}
        <Btn kind="primary" disabled={busy || !username || !password} onClick={submit}>
          {busy ? '登录中…' : '登录'}
        </Btn>
      </div>
    </div>
  )
}
