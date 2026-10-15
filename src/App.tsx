import { useEffect, useState } from 'react'
import { Bell, FolderKanban, LayoutDashboard, LogOut, Menu, Settings2, Sparkles, X } from 'lucide-react'
import { api } from './api'
import { useStore } from './store'
import { Btn } from './components/ui'
import { Brand } from './components/editorial'
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

  const navItems = [
    { href: '#/dashboard', label: '全局看板', icon: LayoutDashboard },
    { href: '#/projects', label: '项目列表', icon: FolderKanban },
    { href: '#/chat', label: 'AI 助手', icon: Sparkles },
    { href: '#/pushes', label: '通知', icon: Bell }, // S46 通知收件箱
    ...(member.role === 'admin' ? [{ href: '#/admin', label: '配置台', icon: Settings2 }] : []),
  ]
  // 选中态：#/admin 深链（#/admin/<sec>/<tab>）与 #/projects 深链（#/projects/<view>，S30）也高亮；#/ 与 #/dashboard 同页
  const isActive = (href: string) =>
    href === '#/dashboard' ? route === '#/' || route === '#/dashboard'
      : href === '#/admin' ? route.startsWith('#/admin')
        : href === '#/projects' ? route.startsWith('#/projects')
          : route === href

  const navigation = (mobile = false) => (
    <nav aria-label={mobile ? '移动导航' : undefined} className={`flex-1 ${mobile ? 'px-3 py-3' : 'px-4 py-5'}`}>
      {!mobile && <div className="editorial-kicker mb-4 px-2">工作区目录</div>}
      {navItems.map(({ href, label, icon: Icon }, index) => {
        const active = isActive(href)
        return (
          <a
            key={href} href={href}
            className={`group relative mb-1 flex items-center gap-3 rounded-[3px] px-3 py-2.5 text-[13px] transition-colors duration-150 ${active ? 'bg-[var(--color-brand-soft)] font-medium text-[var(--color-brand-deep)]' : 'text-[var(--color-ink-soft)] hover:bg-[var(--color-panel)] hover:text-[var(--color-ink)]'}`}
          >
            <span aria-hidden="true" className={`absolute left-0 top-1/2 h-5 w-[2px] -translate-y-1/2 bg-[var(--color-brand)] transition-transform duration-150 ${active ? 'scale-y-100' : 'scale-y-0 group-hover:scale-y-50'}`} />
            <Icon aria-hidden="true" size={15} strokeWidth={1.6} />
            <span>{label}</span>
            <span aria-hidden="true" className="num ml-auto text-[9px] tracking-[0.12em] opacity-55">{String(index + 1).padStart(2, '0')}</span>
          </a>
        )
      })}
    </nav>
  )

  const memberPanel = (
    <div className="border-t border-[var(--color-line)] px-5 py-5">
      <div className="mb-3 flex items-center gap-3">
        <div className="display-type flex h-8 w-8 items-center justify-center rounded-full bg-[var(--color-panel)] text-[14px]">{member.name.slice(0, 1)}</div>
        <div className="min-w-0">
          <div className="truncate text-[12px] font-medium">{member.name}</div>
          <div className="text-[10px] text-[var(--color-ink-soft)]">{member.role === 'admin' ? '系统管理员' : '成员'}</div>
        </div>
      </div>
      <Btn small kind="ghost" onClick={async () => { await api.logout(); await refresh() }}><LogOut aria-hidden="true" size={13} />退出登录</Btn>
    </div>
  )

  return (
    <div className="flex h-full flex-col md:flex-row">
      {/* 移动端顶栏（<768px）：导航入口在抽屉里，桌面端隐藏本栏 */}
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-[var(--color-line)] bg-[var(--color-card)] px-4 md:hidden">
        <Brand compact />
        <button
          type="button" aria-label={navOpen ? '关闭菜单' : '打开菜单'}
          className="flex h-9 w-9 items-center justify-center rounded-full text-[var(--color-ink-soft)] transition-colors hover:bg-[var(--color-panel)]"
          onClick={() => setNavOpen(!navOpen)}
        ><Menu aria-hidden="true" size={20} /></button>
      </header>

      {navOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div className="absolute inset-0 bg-[#171914]/45 fade-in" onClick={() => setNavOpen(false)} />
          <aside className="pop-in absolute left-0 top-0 flex h-full w-72 flex-col border-r border-[var(--color-line)] bg-[var(--color-card)]">
            <div className="flex items-center justify-between border-b border-[var(--color-line)] px-5 py-4">
              <Brand compact />
              <button
                type="button" aria-label="关闭菜单"
                className="flex h-9 w-9 items-center justify-center rounded-full text-[var(--color-ink-soft)] hover:bg-[var(--color-panel)]"
                onClick={() => setNavOpen(false)}
              ><X aria-hidden="true" size={18} /></button>
            </div>
            {navigation(true)}
            {memberPanel}
          </aside>
        </div>
      )}

      <aside className="hidden w-56 shrink-0 flex-col border-r border-[var(--color-line)] bg-[var(--color-card)] md:flex lg:w-60">
        <div className="border-b border-[var(--color-line)] px-5 py-6"><Brand /></div>
        {navigation()}
        <div className="px-6 pb-5 text-[9px] leading-4 tracking-[0.14em] text-[var(--color-ink-faint)]">CLARITY IN EVERY PROJECT</div>
        {memberPanel}
      </aside>

      <main className="app-canvas min-w-0 flex-1 overflow-auto">
        <div className={`mx-auto w-full p-5 md:p-8 xl:px-10 ${path === '/chat' ? 'max-w-[1600px]' : path.startsWith('/admin') ? 'max-w-[1360px]' : 'max-w-[1500px]'}`}>{page}</div>
      </main>
    </div>
  )
}
