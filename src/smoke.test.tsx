// @vitest-environment jsdom
// 前端冒烟（engineering-standards §3：组件测试不设标准层，仅冒烟）
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react'
import Login from './pages/Login'
import App from './App'
import Admin from './pages/Admin'
import Chat from './pages/Chat'
import { StoreProvider } from './store'

const loginFetch = vi.fn(async () =>
  new Response(JSON.stringify({ member: { id: 1, name: '甲', role: 'admin' } }), { status: 200 })
)

beforeEach(() => {
  cleanup()
  loginFetch.mockClear()
  globalThis.fetch = loginFetch as unknown as typeof fetch
})

describe('前端冒烟', () => {
  it('Login 渲染品牌与表单，按钮在填写前禁用', () => {
    render(<Login onLogin={async () => {}} />)
    expect(screen.getByText('🧠 项目大脑')).toBeTruthy()
    expect(screen.getAllByRole('textbox').length).toBe(1)
    expect((screen.getByRole('button', { name: '登录' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('填写后提交：调用登录接口并触发 onLogin', async () => {
    const onLogin = vi.fn(async () => {})
    const { container } = render(<Login onLogin={onLogin} />)
    const inputs = container.querySelectorAll('input')
    fireEvent.change(inputs[0], { target: { value: 'admin' } })
    fireEvent.change(inputs[1], { target: { value: 'secret-1' } })
    const btn = screen.getByRole('button', { name: '登录' }) as HTMLButtonElement
    expect(btn.disabled).toBe(false)
    fireEvent.click(btn)
    await waitFor(() => expect(onLogin).toHaveBeenCalledTimes(1))
    expect(loginFetch).toHaveBeenCalledWith('/api/v1/auth/login', expect.objectContaining({ method: 'POST' }))
  })
})

// 移动端响应式冒烟（PRD §7.1：<768px 顶栏+抽屉导航 / 配置台分区横排 / AI 助手会话选择条）
// jsdom 不做真实断点渲染，这里断言移动端专用结构存在且可交互（删掉移动端 UI 即红）
// jsdom 未实现 scrollIntoView（Chat 挂载即触发），stub 掉
beforeAll(() => { Element.prototype.scrollIntoView = vi.fn() })

describe('移动端响应式冒烟', () => {
  it('App：菜单按钮打开抽屉导航，含全部顶级入口，点击跳转后抽屉关闭', async () => {
    location.hash = '#/dashboard'
    render(<StoreProvider><App /></StoreProvider>)
    fireEvent.click(await screen.findByRole('button', { name: '打开菜单' }))
    const drawer = screen.getByRole('navigation', { name: '移动导航' })
    for (const label of ['全局看板', '项目列表', 'AI 助手', '配置台']) {
      expect(within(drawer).getByRole('link', { name: label })).toBeTruthy()
    }
    fireEvent.click(within(drawer).getByRole('link', { name: '配置台' }))
    await waitFor(() => expect(screen.queryByRole('navigation', { name: '移动导航' })).toBeNull())
  })

  it('App：非管理员抽屉不含配置台入口', async () => {
    location.hash = '#/dashboard'
    const meFetch = vi.fn(async () =>
      new Response(JSON.stringify({ member: { id: 2, name: '乙', role: 'member' } }), { status: 200 }))
    globalThis.fetch = meFetch as unknown as typeof fetch
    render(<StoreProvider><App /></StoreProvider>)
    fireEvent.click(await screen.findByRole('button', { name: '打开菜单' }))
    const drawer = screen.getByRole('navigation', { name: '移动导航' })
    expect(within(drawer).queryByRole('link', { name: '配置台' })).toBeNull()
  })

  it('Admin：分区菜单在移动端以横排胶囊呈现（四个分区齐全）', () => {
    location.hash = '#/admin'
    render(<StoreProvider><Admin /></StoreProvider>)
    const bar = document.querySelector('[data-nav="admin-sections"]')
    expect(bar).toBeTruthy()
    for (const label of ['项目管理', '用户管理', '外部依赖', '运维诊断']) {
      expect(within(bar as HTMLElement).getByRole('link', { name: label })).toBeTruthy()
    }
  })

  // S20-12（v0.22）：机器人参数配置台可视化——开关/限额入口齐全，删掉即红
  it('Admin：飞书配置含机器人开关/未登记群开关/每日限额（S20-12）', async () => {
    location.hash = '#/admin/integrations/feishu'
    const sFetch = vi.fn(async () => new Response(JSON.stringify({
      member: { id: 1, name: '甲', role: 'admin' },
      'im.feishu': { appId: 'cli_x', appSecret: '', botEnabled: false, answerUnregisteredGroups: true, commandQuotaPerDay: 50 },
      calendar: {},
    }), { status: 200 }))
    globalThis.fetch = sFetch as unknown as typeof fetch
    render(<StoreProvider><Admin section="integrations" tab="feishu" /></StoreProvider>)
    expect((await screen.findByLabelText(/机器人指令通道（私聊\/群@）/) as HTMLInputElement).checked).toBe(false)
    expect((screen.getByLabelText(/未登记群也响应问答/) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText(/每成员每日指令限额/) as HTMLInputElement).value).toBe('50')
    expect(screen.getByText(/保存即热生效/)).toBeTruthy()
  })

  it('Chat：移动端会话选择条列出全部会话并可新建', async () => {
    location.hash = '#/chat'
    const chatFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/chat/sessions/1/messages')) return new Response(JSON.stringify({ messages: [] }), { status: 200 })
      return new Response(JSON.stringify({
        sessions: [
          { id: 1, title: '会话一', created_at: 1, updated_at: 1 },
          { id: 2, title: '会话二', created_at: 2, updated_at: 2 },
        ],
      }), { status: 200 })
    })
    globalThis.fetch = chatFetch as unknown as typeof fetch
    render(<StoreProvider><Chat /></StoreProvider>)
    const select = await waitFor(() => {
      const el = document.querySelector('[data-nav="chat-sessions"]') as HTMLSelectElement | null
      expect(el).toBeTruthy()
      return el!
    })
    expect(within(select).getAllByRole('option').length).toBe(2)
    expect(within(select.parentElement as HTMLElement).getByRole('button', { name: '＋ 新会话' })).toBeTruthy()
  })
})
