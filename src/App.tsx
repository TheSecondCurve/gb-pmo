import { useEffect, useState } from 'react'
import { api } from './api'
import { useStore } from './store'
import { Btn } from './components/ui'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import Projects from './pages/Projects'
import ProjectDetail from './pages/ProjectDetail'
import Admin from './pages/Admin'

// hash 路由（自写，静态托管无需 history fallback）
function useHashRoute(): [string, (to: string) => void] {
  const [hash, setHash] = useState(() => location.hash || '#/')
  useEffect(() => {
    const h = () => setHash(location.hash || '#/')
    window.addEventListener('hashchange', h)
    return () => window.removeEventListener('hashchange', h)
  }, [])
  const nav = (to: string) => { location.hash = to }
  return [hash, nav]
}

export default function App() {
  const { member, ready, refresh } = useStore()
  const [route] = useHashRoute()

  if (!ready) return <div className="flex h-full items-center justify-center text-[var(--color-ink-soft)]">加载中…</div>
  if (!member) return <Login onLogin={refresh} />

  const path = route.replace(/^#/, '') || '/'
  let page: JSX.Element
  const m = path.match(/^#?\/projects\/(\d+)$/)
  if (path === '/' || path === '/dashboard') page = <Dashboard />
  else if (path === '/projects') page = <Projects />
  else if (m) page = <ProjectDetail id={Number(m[1])} />
  else if (path === '/admin') page = member.role === 'admin' ? <Admin /> : <div className="p-8">需要管理员权限</div>
  else page = <div className="p-8">页面不存在：{path}</div>

  return (
    <div className="flex h-full">
      <aside className="hidden w-52 shrink-0 flex-col border-r border-[var(--color-line)] bg-[var(--color-card)] md:flex">
        <div className="px-4 py-4 text-[15px] font-bold">🧠 项目大脑</div>
        <nav className="flex-1 px-2 text-[13px]">
          {[
            ['#/dashboard', '全局看板'],
            ['#/projects', '项目列表'],
            ...(member.role === 'admin' ? [['#/admin', '配置台']] : []),
          ].map(([href, label]) => (
            <a
              key={href} href={href}
              className={`mb-0.5 block rounded-md px-3 py-2 ${route === href ? 'bg-[var(--color-brand-soft)] font-medium text-[var(--color-brand)]' : 'hover:bg-[var(--color-bg)]'}`}
            >{label}</a>
          ))}
        </nav>
        <div className="border-t border-[var(--color-line)] px-4 py-3 text-[12px] text-[var(--color-ink-soft)]">
          <div>{member.name}（{member.role === 'admin' ? '管理员' : '成员'}）</div>
          <Btn small kind="ghost" onClick={async () => { await api.logout(); await refresh() }}>退出登录</Btn>
        </div>
      </aside>

      <main className="flex-1 overflow-auto">
        <div className="mx-auto max-w-6xl p-4 md:p-6 fade-in">{page}</div>
      </main>
    </div>
  )
}
