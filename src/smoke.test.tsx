// @vitest-environment jsdom
// 前端冒烟（engineering-standards §3：组件测试不设标准层，仅冒烟）
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react'
import Login from './pages/Login'
import App from './App'
import Admin from './pages/Admin'
import Chat from './pages/Chat'
import Projects from './pages/Projects'
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

  // S20-12（v0.22）：机器人参数配置台可视化——开关/限额入口齐全，删掉即红；S20-13（v0.23）：多轮记忆参数
  it('Admin：飞书配置含机器人开关/未登记群开关/每日限额（S20-12）', async () => {
    location.hash = '#/admin/integrations/feishu'
    const sFetch = vi.fn(async () => new Response(JSON.stringify({
      member: { id: 1, name: '甲', role: 'admin' },
      'im.feishu': { appId: 'cli_x', appSecret: '', botEnabled: false, answerUnregisteredGroups: true, commandQuotaPerDay: 50, contextTurns: 8, contextIdleMinutes: 120 },
      calendar: {},
    }), { status: 200 }))
    globalThis.fetch = sFetch as unknown as typeof fetch
    render(<StoreProvider><Admin section="integrations" tab="feishu" /></StoreProvider>)
    expect((await screen.findByLabelText(/机器人指令通道（私聊\/群@）/) as HTMLInputElement).checked).toBe(false)
    expect((screen.getByLabelText(/未登记群也响应问答/) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText(/每成员每日指令限额/) as HTMLInputElement).value).toBe('50')
    expect((screen.getByLabelText(/多轮记忆条数/) as HTMLInputElement).value).toBe('8')
    expect((screen.getByLabelText(/空闲开新话题（分钟）/) as HTMLInputElement).value).toBe('120')
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

// PRD S30（v0.29）— 项目组合页冒烟：四视图 + 日期文案四式 + 未排期沉底 + 甘特形态。
// jsdom 不量像素，断言结构契约（data-testid 锚点）；坐标正确性由 src/gantt.test.ts 纯函数锁定。
describe('S30 项目组合页（v0.29）', () => {
  const P = (id: number, over: Record<string, unknown>) => ({
    id, name: `项目${id}`, templateCode: 'custom', typeName: '软件交付',
    status: 'active', priority: 'medium', leadMemberId: 1, leadName: '张三', clientName: null,
    planStartDate: null, planEndDate: null, daysToDelivery: null,
    overdueTasks: 0, silentDays: null, lastEventAt: null, updatedAt: 1759000000000, ...over,
  })
  // P1 双端 / P2 只有交付 / P3 只有开始（high）/ P4 全空 / P5 已结项（有日期）/ P6 已取消（全空）
  const projectsFixture = [
    P(1, { name: '全排期项目', planStartDate: '2026-09-01', planEndDate: '2026-10-15', daysToDelivery: 13 }),
    P(2, { name: '只有交付项目', leadMemberId: 1, leadName: '张三', priority: 'low', planEndDate: '2026-11-01', daysToDelivery: 30 }),
    P(3, { name: '只有开始项目', leadMemberId: 2, leadName: '李四', priority: 'high', planStartDate: '2026-09-15' }),
    P(4, { name: '未排期项目', leadMemberId: 2, leadName: '李四' }),
    P(5, { name: '已结项项目', status: 'closed', planStartDate: '2026-06-01', planEndDate: '2026-08-31' }),
    P(6, { name: '已取消项目', status: 'cancelled', leadMemberId: 3, leadName: '王五' }),
  ]
  const membersFixture = { members: [{ id: 1, name: '张三' }, { id: 2, name: '李四' }, { id: 3, name: '王五' }] }

  const portfolioFetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.startsWith('/api/v1/projects')) return new Response(JSON.stringify({ projects: projectsFixture }), { status: 200 })
    if (url.startsWith('/api/v1/members')) return new Response(JSON.stringify(membersFixture), { status: 200 })
    return new Response(JSON.stringify({ tasks: [] }), { status: 200 })
  })
  beforeEach(() => {
    cleanup()
    portfolioFetch.mockClear()
    globalThis.fetch = portfolioFetch as unknown as typeof fetch
  })

  it('S30-2: 表格视图——日期文案四式 + 未排期沉底成组不穿插 + 排序可切', async () => {
    location.hash = '#/projects'
    render(<StoreProvider><Projects view="table" /></StoreProvider>)
    // 日期文案四式（S30-4）
    expect(await screen.findByText('2026-09-01 ~ 2026-10-15')).toBeTruthy()
    expect(screen.getByText('交付 2026-11-01')).toBeTruthy()
    expect(screen.getByText('2026-09-15 起')).toBeTruthy()
    // 未排期成组且在有序流之后（S30-2 null 沉底不穿插）
    const group = document.querySelector('[data-testid="unscheduled-group"]') as HTMLElement | null
    expect(group).toBeTruthy()
    expect(group!.textContent).toContain('未排期（2）')
    const rowUnscheduled = screen.getByText('未排期项目').closest('tr')!
    const rowScheduled = screen.getByText('全排期项目').closest('tr')!
    expect(rowScheduled.compareDocumentPosition(rowUnscheduled) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // 排序切换：交付临近 → 按剩余天数升序（13 天的排在 30 天前）
    fireEvent.change(screen.getByLabelText('排序维度'), { target: { value: 'delivery' } })
    const row30 = screen.getByText('只有交付项目').closest('tr')!
    expect(rowScheduled.compareDocumentPosition(row30) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('S30-2: 看板视图——按状态三列分组，终态列可折叠', async () => {
    render(<StoreProvider><Projects view="board" /></StoreProvider>)
    const active = await waitFor(() => {
      const el = document.querySelector('[data-testid="board-col-active"]') as HTMLElement | null
      expect(el).toBeTruthy()
      return el!
    })
    expect(active.textContent).toContain('进行中')
    expect(within(active).getAllByRole('link').length).toBe(4)
    const closed = document.querySelector('[data-testid="board-col-closed"]') as HTMLElement
    expect(within(closed).getAllByRole('link').length).toBe(1)
    const cancelled = document.querySelector('[data-testid="board-col-cancelled"]') as HTMLElement
    expect(within(cancelled).getAllByRole('link').length).toBe(1)
  })

  it('S30-2: 人员视图——按牵头人分组，组间按在跑项目数降序', async () => {
    render(<StoreProvider><Projects view="people" /></StoreProvider>)
    await screen.findByText('全排期项目')
    const groups = Array.from(document.querySelectorAll('[data-testid="people-group"]')) as HTMLElement[]
    expect(groups.length).toBe(3)
    const order = groups.map((g) => g.textContent)
    // 张三 2 在跑（共3）> 李四 2 在跑（共2）> 王五 0 在跑；同在跑数比总数
    expect(order.findIndex((t) => t.includes('张三'))).toBeLessThan(order.findIndex((t) => t.includes('李四')))
    expect(order.findIndex((t) => t.includes('李四'))).toBeLessThan(order.findIndex((t) => t.includes('王五')))
  })

  it('S30-3: 时间线——今日线 + 四形态条形落位 + 未排期分组不入轴', async () => {
    render(<StoreProvider><Projects view="timeline" /></StoreProvider>)
    await screen.findByTestId('gantt-today')
    // 有日期的 4 个项目画条（P1 区间 / P2 截止旗 / P3 开放条 / P5 区间灰）；全空 2 个不入轴
    expect(document.querySelectorAll('[data-testid="gantt-bar"]').length).toBe(4)
    expect(document.querySelectorAll('[data-testid="gantt-tick"]').length).toBeGreaterThanOrEqual(2)
    const unscheduled = document.querySelector('[data-testid="unscheduled-group"]') as HTMLElement
    expect(unscheduled.textContent).toContain('未排期（2）')
    expect(unscheduled.textContent).toContain('未排期项目')
  })

  it('S30-3: 全部项目无日期 → 时间线空态引导而非空白图', async () => {
    const emptyFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('/api/v1/projects')) return new Response(JSON.stringify({ projects: [P(9, { name: '空项目' })] }), { status: 200 })
      if (url.startsWith('/api/v1/members')) return new Response(JSON.stringify(membersFixture), { status: 200 })
      return new Response(JSON.stringify({ tasks: [] }), { status: 200 })
    })
    globalThis.fetch = emptyFetch as unknown as typeof fetch
    render(<StoreProvider><Projects view="timeline" /></StoreProvider>)
    expect(await screen.findByText(/暂无可排期项目/)).toBeTruthy()
    expect(screen.queryByTestId('gantt-today')).toBeNull()
  })

  it('S30-2: 视图 Tabs 深链（#/projects/<view>）齐全', async () => {
    render(<StoreProvider><Projects view="table" /></StoreProvider>)
    const tabs = await waitFor(() => {
      const el = document.querySelector('[data-nav="portfolio-views"]') as HTMLElement | null
      expect(el).toBeTruthy()
      return el!
    })
    for (const [href, label] of [
      ['#/projects/board', '看板'], ['#/projects/table', '表格'], ['#/projects/people', '人员'], ['#/projects/timeline', '时间线'],
    ] as [string, string][]) {
      const link = within(tabs).getByRole('link', { name: label })
      expect(link.getAttribute('href')).toBe(href)
    }
  })
})
