import { useState } from 'react'
import { ArrowRight } from 'lucide-react'
import { api } from '../api'
import { Brand } from '../components/editorial'
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
    <div className="grid min-h-full bg-[var(--color-card)] md:grid-cols-[1.12fr_0.88fr]">
      <section data-testid="login-cover" className="paper-grid editorial-enter relative hidden flex-col justify-between overflow-hidden border-r border-[var(--color-line)] p-10 md:flex lg:p-14 xl:p-16">
        <Brand />
        <div className="relative z-10 my-16 max-w-[680px]">
          <div className="editorial-kicker">Project clarity / 项目刊物</div>
          <h1 className="display-type mt-7 text-[52px] leading-[1.16] tracking-[-0.055em] lg:text-[68px] xl:text-[76px]">
            让每一个项目，<br />都有清晰的脉络。
          </h1>
          <p className="mt-7 max-w-[440px] text-[14px] leading-7 text-[var(--color-ink-soft)]">
            把进度、风险与决策放在同一版面。<br />让团队看见事实，也看见下一步。
          </p>
        </div>
        <div className="relative z-10 grid grid-cols-3 border-t border-[var(--color-ink)] pt-4 text-[11px] text-[var(--color-ink-soft)]">
          {[['01', '多项目总览'], ['02', 'LLM 大脑'], ['03', '全员透明']].map(([index, label]) => (
            <div key={index} className="flex items-baseline gap-2">
              <span className="num text-[9px] text-[var(--color-brand)]">{index}</span>
              <span>{label}</span>
            </div>
          ))}
        </div>
        <div aria-hidden="true" className="display-type pointer-events-none absolute -bottom-20 -right-6 text-[220px] leading-none text-[var(--color-ink)] opacity-[0.025]">项</div>
      </section>

      <main className="flex min-h-screen flex-col md:min-h-0">
        <div className="border-b border-[var(--color-line)] p-5 md:hidden"><Brand compact /></div>
        <div className="flex flex-1 items-center justify-center px-6 py-12 md:px-10 lg:px-16">
          <div className="editorial-enter-late w-full max-w-[360px]">
            <div className="editorial-kicker">Workspace access</div>
            <h2 className="display-type mt-4 text-[34px] leading-tight">欢迎回来</h2>
            <p className="mb-9 mt-3 text-[13px] text-[var(--color-ink-soft)]">登录，进入今天的项目版面。</p>
            <Field label="用户名">
              <input className={inputCls} value={username} autoFocus onChange={(e) => setUsername(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submit()} />
            </Field>
            <Field label="密码">
              <input className={inputCls} type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submit()} />
            </Field>
            {err && <div className="mb-4 rounded-[3px] bg-[var(--color-bad-soft)] px-3 py-2 text-[12px] text-[var(--color-bad)]">{err}</div>}
            <div className="mt-6 [&>button]:w-full">
              <Btn kind="primary" disabled={busy || !username || !password} onClick={submit}>
                {busy ? '登录中…' : <>登录<ArrowRight aria-hidden="true" size={14} /></>}
              </Btn>
            </div>
            <div className="mt-8 border-t border-[var(--color-line)] pt-4 text-[10px] leading-5 text-[var(--color-ink-faint)]">
              企业多项目管理 · LLM 大脑 · 全员透明
            </div>
          </div>
        </div>
      </main>
    </div>
  )
}
