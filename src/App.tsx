import { useEffect, useState } from 'react'
import { api } from './api'
import { useStore } from './store'
import { Btn } from './components/ui'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import Projects, { type PortfolioView } from './pages/Projects'
import ProjectDetail from './pages/ProjectDetail'
import Admin from './pages/Admin'
import Chat from './pages/Chat'
import Pushes from './pages/Pushes'

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
  const [navOpen, setNavOpen] = useState(false)
  // 路由变化即收起移动端抽屉（点链接 / 前进后退统一走这里）
  useEffect(() => {
    const h = () => setNavOpen(false)
    window.addEventListener('hashchange', h)
    return () => window.removeEventListener('hashchange', h)
  }, [])

  if (!ready) return <div className="flex h-full items-center justify-center text-[var(--color-ink-soft)]">加载中…</div>
  if (!member) return <Login onLogin={refresh} />

  const path = route.replace(/^#/, '') || '/'
  let page: JSX.Element
  const m = path.match(/^#?\/projects\/(\d+)$/)
  // S30 组合页视图深链：#/projects/board|table|people|timeline（#/projects 缺省表格）
  const pvm = path.match(/^\/projects\/(board|table|people|timeline)$/)
  if (path === '/' || path === '/dashboard') page = <Dashboard />
  else if (path === '/projects') page = <Projects view="table" />
  else if (pvm) page = <Projects view={pvm[1] as PortfolioView} />
  else if (path === '/chat') page = <Chat /> // S24 AI 助手（全员）
  else if (path === '/pushes') page = <Pushes /> // S46 通知收件箱（全员，仅本人）
  else if (m) page = <ProjectDetail id={Number(m[1])} />
  else if (path === '/admin' || path.startsWith('/admin/')) {
    // 配置台二级路由：#/admin/<section>/<tab>（S17，仅系统管理员；Shell 负责缺省段归一化）
    const am = path.match(/^\/admin(?:\/([a-z]+))?(?:\/([a-z]+))?/)
    page = member.role === 'admin'
      ? <Admin section={am?.[1]} tab={am?.[2]} />
      : <div className="p-8 text-[var(--color-ink-soft)]">需要系统管理员权限</div>
  }
  else page = <div className="p-8">页面不存在：{path}</div>

  const navItems: [string, string][] = [
    ['#/dashboard', '全局看板'],
    ['#/projects', '项目列表'],
    ['#/chat', 'AI 助手'],
    ['#/pushes', '通知'], // S46 通知收件箱
    ...(member.role === 'admin' ? [['#/admin', '配置台'] as [string, string]] : []),
  ]
  // 选中态：#/admin 深链（#/admin/<sec>/<tab>）与 #/projects 深链（#/projects/<view>，S30）也高亮；#/ 与 #/dashboard 同页
  const isActive = (href: string) =>
    href === '#/dashboard' ? route === '#/' || route === '#/dashboard'
      : href === '#/admin' ? route.startsWith('#/admin')
        : href === '#/projects' ? route.startsWith('#/projects')
          : route === href
  const linkCls = (href: string) => `block rounded-md px-3 py-2 ${isActive(href) ? 'bg-[var(--color-brand-soft)] font-medium text-[var(--color-brand)]' : 'hover:bg-[var(--color-bg)]'}`

  return (
    <div className="flex h-full flex-col md:flex-row">
      {/* 移动端顶栏（<768px）：导航入口在抽屉里，桌面端隐藏本栏 */}
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-[var(--color-line)] bg-[var(--color-card)] px-4 md:hidden">
        <div className="text-[15px] font-bold">🧠 项目大脑</div>
        <button
          type="button" aria-label={navOpen ? '关闭菜单' : '打开菜单'}
          className="rounded-md px-2 py-1 text-[18px] leading-none text-[var(--color-ink-soft)] hover:bg-[var(--color-bg)]"
          onClick={() => setNavOpen(!navOpen)}
        >☰</button>
      </header>

      {navOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div className="absolute inset-0 bg-black/30 fade-in" onClick={() => setNavOpen(false)} />
          <aside className="pop-in absolute left-0 top-0 flex h-full w-64 flex-col border-r border-[var(--color-line)] bg-[var(--color-card)]">
            <div className="flex items-center justify-between border-b border-[var(--color-line)] px-4 py-3">
              <div className="text-[15px] font-bold">🧠 项目大脑</div>
              <button
                type="button" aria-label="关闭菜单"
                className="rounded-md px-2 py-1 text-[var(--color-ink-soft)] hover:bg-[var(--color-bg)]"
                onClick={() => setNavOpen(false)}
              >✕</button>
            </div>
            <nav aria-label="移动导航" className="flex-1 px-2 py-2 text-[14px]">
              {navItems.map(([href, label]) => <a key={href} href={href} className={`mb-0.5 ${linkCls(href)}`}>{label}</a>)}
            </nav>
            <div className="border-t border-[var(--color-line)] px-4 py-3 text-[12px] text-[var(--color-ink-soft)]">
              <div className="mb-1">{member.name}（{member.role === 'admin' ? '系统管理员' : '成员'}）</div>
              <Btn small kind="ghost" onClick={async () => { await api.logout(); await refresh() }}>退出登录</Btn>
            </div>
          </aside>
        </div>
      )}

      <aside className="hidden w-52 shrink-0 flex-col border-r border-[var(--color-line)] bg-[var(--color-card)] md:flex">
        <div className="px-4 py-4 text-[15px] font-bold">🧠 项目大脑</div>
        <nav className="flex-1 px-2 text-[13px]">
          {navItems.map(([href, label]) => <a key={href} href={href} className={`mb-0.5 ${linkCls(href)}`}>{label}</a>)}
        </nav>
        <div className="border-t border-[var(--color-line)] px-4 py-3 text-[12px] text-[var(--color-ink-soft)]">
          <div>{member.name}（{member.role === 'admin' ? '系统管理员' : '成员'}）</div>
          <Btn small kind="ghost" onClick={async () => { await api.logout(); await refresh() }}>退出登录</Btn>
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-6xl p-4 md:p-6 fade-in">{page}</div>
      </main>
    </div>
  )
}
