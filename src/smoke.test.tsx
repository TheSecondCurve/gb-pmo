// @vitest-environment jsdom
// 前端冒烟（engineering-standards §3：组件测试不设标准层，仅冒烟）
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react'
import Login from './pages/Login'
import App from './App'
import Admin from './pages/Admin'
import Chat from './pages/Chat'
import Projects from './pages/Projects'
import ProjectDetail from './pages/ProjectDetail'
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

  // S34（v0.35）：数据库异地备份配置卡——存储字段 + 三按钮齐全，删掉即红
  it('Admin：数据库备份配置卡（S34）——endpoint/bucket/保留份数 + 测试连接/立即备份按钮', async () => {
    location.hash = '#/admin/ops/backup'
    const sFetch = vi.fn(async () => new Response(JSON.stringify({
      backup: { endpoint: '', region: '', bucket: '', accessKeyId: '', secretAccessKey: '', prefix: 'backups/', pathStyle: false, keepCount: 30 },
      scheduler: { backupCron: '30 3 * * *', backupEnabled: true },
      history: [],
    }), { status: 200 }))
    globalThis.fetch = sFetch as unknown as typeof fetch
    render(<StoreProvider><Admin section="ops" tab="backup" /></StoreProvider>)
    expect((await screen.findByLabelText(/S3 兼容端点/)) as HTMLInputElement).toBeTruthy()
    expect((screen.getByLabelText(/Bucket/) as HTMLInputElement).value).toBe('')
    expect((screen.getByLabelText(/云端保留份数（1~365，超出删最旧）/) as HTMLInputElement).value).toBe('30')
    expect(screen.getByRole('button', { name: /测试连接（当前表单值，可先测后存）/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: '立即备份' })).toBeTruthy()
    expect(screen.getByText(/30 3 \* \* \*/)).toBeTruthy() // 定时状态行回显 cron
  })

  // S40-4（v0.43）：LLM 卡片可编辑超时——默认 120s（K22：GLM 大 JSON 实测约 117s），删掉即红
  it('Admin：LLM 配置卡含超时编辑字段（S40-4，默认 120s）', async () => {
    location.hash = '#/admin/integrations/llm'
    const sFetch = vi.fn(async () => new Response(JSON.stringify({
      member: { id: 1, name: '甲', role: 'admin' },
      llm: { provider: 'deepseek', deepseek: { apiKey: '', baseUrl: '', model: '' }, 'glm-coding': { apiKey: '', baseUrl: '', model: '' }, timeoutMs: 120000 },
    }), { status: 200 }))
    globalThis.fetch = sFetch as unknown as typeof fetch
    render(<StoreProvider><Admin section="integrations" tab="llm" /></StoreProvider>)
    expect(((await screen.findByLabelText(/超时（秒/)) as HTMLInputElement).value).toBe('120')
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
    overdueTasks: 0, silentDays: null, lastEventAt: null, updatedAt: 1759000000000,
    tasksTotal: 0, tasksDone: 0, ...over,
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

// PRD S38/S39（v0.42）冒烟：新建任务默认未指派（K20 推翻 D3）；类型初始化提示词 + AI 初始分配入口。
describe('S38/S39 任务责任人与 AI 初始分配（v0.42）', () => {
  const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200 })
  const detailFixture = {
    id: 1, name: '项目甲', templateCode: 'lianmai_365', projectTypeId: 1, typeName: '365连麦',
    status: 'active', priority: 'medium', leadMemberId: 1, leadName: '张三', clientName: null,
    planStartDate: '2026-10-09', planEndDate: '2026-11-09', daysToDelivery: 31,
    tasksTotal: 1, tasksDone: 0,
    tasks: [{ id: 11, projectId: 1, title: '任务一', responsibleMemberId: null, responsibleName: null, status: 'todo', planStartDate: '2026-10-09', planEndDate: null, isOverdue: false, refCount: 0 }],
    milestones: [],
  }
  let draftPollCount = 0
  const detailFetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.startsWith('/api/v1/auth/me')) return json({ member: { id: 1, name: '甲', role: 'admin' } })
    // v0.45（S44）异步草案：POST 启动 202 → GET 轮询（先 running 后 done）
    if (url.includes('/draft-init-assignments/d1')) {
      draftPollCount += 1
      if (draftPollCount === 1) return json({ status: 'running', elapsedMs: 800 })
      return json({ status: 'done', assignments: [{ taskId: 11, title: '任务一', responsibleMemberId: 2, planStartDate: '2026-10-10', planEndDate: '2026-10-12' }], warnings: [] })
    }
    if (url.includes('/draft-init-assignments')) {
      return json({ draftId: 'd1', status: 'running' })
    }
    if (url.startsWith('/api/v1/projects/1/events')) return json({ events: [] })
    if (url.startsWith('/api/v1/projects/1')) return json(detailFixture)
    if (url.startsWith('/api/v1/projects')) {
      return json({ projects: [{ id: 1, name: '项目甲', templateCode: 'lianmai_365', status: 'active', priority: 'medium', leadMemberId: 1, leadName: '张三', clientName: null, planStartDate: '2026-10-09', planEndDate: '2026-11-09', daysToDelivery: 31, overdueTasks: 0, silentDays: null, lastEventAt: null, updatedAt: 1760000000000, tasksTotal: 1, tasksDone: 0 }] })
    }
    if (url.startsWith('/api/v1/members')) return json({ members: [{ id: 1, name: '张三', status: 'active' }, { id: 2, name: '李四', status: 'active' }] })
    if (url.startsWith('/api/v1/channels')) return json({ channels: [] })
    if (url.startsWith('/api/v1/project-types')) {
      return json({ types: [{ id: 1, code: 'lianmai_365', name: '365连麦', description: null, initPrompt: '彩排安排在交付前 3 天', tasks: [{ title: '任务A', refs: [] }], status: 'active', projectCount: 0, openProjectCount: 0 }] })
    }
    return json({ tasks: [] })
  })
  beforeEach(() => {
    cleanup()
    detailFetch.mockClear()
    draftPollCount = 0
    globalThis.fetch = detailFetch as unknown as typeof fetch
  })

  it('S38-6: 新建任务责任人下拉默认空（未指派）；立项弹窗牵头人不再标注「任务默认责任人」', async () => {
    location.hash = '#/projects/1'
    render(<StoreProvider><ProjectDetail id={1} /></StoreProvider>)
    // 新建行：责任人下拉默认「（未指派）」，placeholder 不再写「默认牵头人」
    expect(await screen.findByPlaceholderText(/默认未指派/)).toBeTruthy()
    const ownerSelect = (await screen.findByLabelText('新任务责任人（默认未指派）')) as HTMLSelectElement
    expect(ownerSelect.value).toBe('')
    expect(within(ownerSelect).getByRole('option', { name: '（未指派）' })).toBeTruthy()

    // 立项弹窗：牵头人≠任务默认责任人（S38 解耦）
    cleanup()
    location.hash = '#/projects'
    render(<StoreProvider><Projects view="table" /></StoreProvider>)
    fireEvent.click(await screen.findByRole('button', { name: '+ 立项' }))
    expect(await screen.findByText(/牵头人 \*（必填/)).toBeTruthy()
    expect(screen.queryByText(/任务默认责任人/)).toBeNull()
  })

  it('S2-4: 任务面标题旁展示稳定编号 #id（只读，不进标题编辑态；与机器人盘点/事件引用同口径）', async () => {
    location.hash = '#/projects/1'
    render(<StoreProvider><ProjectDetail id={1} /></StoreProvider>)
    const row = (await screen.findAllByTestId('task-row'))[0]
    expect(within(row).getByText('#11')).toBeTruthy() // fixture 任务一 id=11
    // 编号只读：点击编号不应进入编辑态（标题编辑仍由标题文本触发）
    fireEvent.click(within(row).getByText('#11'))
    expect(within(row).queryByDisplayValue('任务一')).toBeNull()
  })

  it('S39-8: 类型编辑器渲染初始化提示词字段；项目详情有 AI 初始分配入口与草案弹窗', async () => {
    // 配置台类型编辑器：提示词字段渲染并回显既有值
    location.hash = '#/admin/project/types'
    render(<StoreProvider><Admin section="project" tab="types" /></StoreProvider>)
    fireEvent.click(await screen.findByRole('button', { name: '编辑' }))
    const promptField = (await screen.findByLabelText(/初始化提示词/)) as HTMLTextAreaElement
    expect(promptField.value).toBe('彩排安排在交付前 3 天')

    // 项目详情：AI 初始分配入口 → 草案弹窗（行可编辑 + 应用按钮）
    // S44-5（v0.45）：异步作业——先显示等待进度（running），轮询到 done 后行渲染
    cleanup()
    location.hash = '#/projects/1'
    render(<StoreProvider><ProjectDetail id={1} /></StoreProvider>)
    fireEvent.click(await screen.findByRole('button', { name: /AI 初始分配/ }))
    expect(await screen.findByText('✨ AI 初始分配（S39）')).toBeTruthy()
    expect(await screen.findByTestId('init-assign-waiting')).toBeTruthy() // S44-5：等待进度呈现
    expect((await screen.findByLabelText('任务 任务一 责任人', {}, { timeout: 5000 })) as HTMLSelectElement)
    const rowSelect = (await screen.findByLabelText('任务 任务一 责任人')) as HTMLSelectElement
    expect(rowSelect.value).toBe('2') // 草案建议责任人预填
    expect(screen.getByRole('button', { name: '应用 1 项' })).toBeTruthy()
  })
})

// PRD S41/S42/S43（v0.44）冒烟：任务行状态色彩（行底色 + 着色下拉/徽章，逾期红优先）、
// 项目详情「进度与排期」卡（堆叠进度条 + 任务级甘特 + 里程碑刻度 + 未排期组）、
// 组合页任务进度条（表格列 + 看板卡）。jsdom 不量像素，断言结构契约（data-testid/data-* 锚点）；
// 坐标正确性由 gantt.test.ts / progress.test.ts 纯函数锁定。色彩语义见 design.md K23。
describe('S41/S42/S43 状态色彩与进度排期可视化（v0.44）', () => {
  const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200 })
  const T = (id: number, over: Record<string, unknown>) => ({
    id, projectId: 1, responsibleMemberId: null, responsibleName: null,
    status: 'todo', planStartDate: null, planEndDate: null, isOverdue: false, refCount: 0, ...over,
  })
  // 项目1（进行中）：五任务覆盖 todo/doing/done/逾期/只有截止/未排期 → 完成 1/5（20%）、逾期 1
  const detailActive = {
    id: 1, name: '项目甲', templateCode: 'lianmai_365', projectTypeId: 1, typeName: '365连麦',
    status: 'active', priority: 'medium', leadMemberId: 1, leadName: '张三', clientName: null,
    planStartDate: '2026-09-01', planEndDate: '2026-11-09', daysToDelivery: 31,
    tasksTotal: 5, tasksDone: 1,
    tasks: [
      T(11, { title: '未排期任务' }),
      T(12, { title: '进行中任务', status: 'doing', planStartDate: '2026-10-01', planEndDate: '2026-10-20' }),
      T(13, { title: '已完成任务', status: 'done', planStartDate: '2026-09-01', planEndDate: '2026-09-10' }),
      T(14, { title: '逾期任务', status: 'doing', planStartDate: '2026-08-20', planEndDate: '2026-09-01', isOverdue: true }),
      T(15, { title: '只有截止任务', planEndDate: '2026-12-01' }),
    ],
    milestones: [
      { id: 21, projectId: 1, name: '中期评审', planDate: '2026-10-15', actualDate: null, status: 'planned' },
      { id: 22, projectId: 1, name: '交付验收', planDate: '2026-11-01', actualDate: null, status: 'missed' },
    ],
  }
  // 项目2（已结项只读）：done + todo 各一（结项只读快照，冻结的 todo 保持原样）
  const detailClosed = {
    ...detailActive, id: 2, name: '项目乙', status: 'closed', closeoutSummary: '已交付',
    tasks: [T(31, { title: '结项已完成任务', status: 'done' }), T(32, { title: '结项冻结任务' })],
    milestones: [],
  }
  // 项目3（进行中，全部任务无日期）→ 甘特空态引导
  const detailUndated = { ...detailActive, id: 3, name: '项目丙', tasks: [T(41, { title: '无日期任务甲' })], milestones: [] }

  const visFetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.startsWith('/api/v1/auth/me')) return json({ member: { id: 1, name: '甲', role: 'admin' } })
    if (url.startsWith('/api/v1/projects/1/events')) return json({ events: [] })
    if (url.startsWith('/api/v1/projects/1')) return json(detailActive)
    if (url.startsWith('/api/v1/projects/2/events')) return json({ events: [] })
    if (url.startsWith('/api/v1/projects/2')) return json(detailClosed)
    if (url.startsWith('/api/v1/projects/3/events')) return json({ events: [] })
    if (url.startsWith('/api/v1/projects/3')) return json(detailUndated)
    if (url.startsWith('/api/v1/projects')) {
      const P = (id: number, over: Record<string, unknown>) => ({
        id, name: `项目${id}`, templateCode: 'lianmai_365', typeName: '365连麦',
        status: 'active', priority: 'medium', leadMemberId: 1, leadName: '张三', clientName: null,
        planStartDate: '2026-09-01', planEndDate: '2026-11-09', daysToDelivery: 31,
        overdueTasks: 0, silentDays: null, lastEventAt: null, updatedAt: 1760000000000, ...over,
      })
      return json({ projects: [P(1, { name: '项目甲', tasksTotal: 5, tasksDone: 1, overdueTasks: 1 }), P(2, { name: '空项目', tasksTotal: 0, tasksDone: 0 })] })
    }
    if (url.startsWith('/api/v1/members')) return json({ members: [{ id: 1, name: '张三', status: 'active' }] })
    if (url.startsWith('/api/v1/channels')) return json({ channels: [] })
    return json({ tasks: [] })
  })
  beforeEach(() => {
    cleanup()
    visFetch.mockClear()
    globalThis.fetch = visFetch as unknown as typeof fetch
  })

  const renderDetail = async (id: number) => {
    location.hash = `#/projects/${id}`
    render(<StoreProvider><ProjectDetail id={id} /></StoreProvider>)
    await screen.findAllByTestId('task-row')
  }
  const rowOf = (title: string) =>
    Array.from(document.querySelectorAll('[data-testid="task-row"]') as NodeListOf<HTMLElement>).find((r) => r.textContent!.includes(title))!

  it('S41-1: 任务行按状态整行着色（data-visual），状态下拉按当前值着色；逾期红优先于状态色', async () => {
    await renderDetail(1)
    expect(rowOf('未排期任务').dataset.visual).toBe('todo')
    expect(rowOf('进行中任务').dataset.visual).toBe('doing')
    expect(rowOf('已完成任务').dataset.visual).toBe('done')
    expect(rowOf('逾期任务').dataset.visual).toBe('overdue') // 逾期优先于 doing
    expect(rowOf('只有截止任务').dataset.visual).toBe('todo')
    // 可编辑态：状态下拉按当前值着色（todo=muted / doing=info / done=ok）
    expect(rowOf('未排期任务').querySelector('select[data-tone="muted"]')).toBeTruthy()
    expect(rowOf('进行中任务').querySelector('select[data-tone="info"]')).toBeTruthy()
    expect(rowOf('已完成任务').querySelector('select[data-tone="ok"]')).toBeTruthy()
    // 逾期徽章既有口径保留
    expect(within(rowOf('逾期任务')).getByText('逾期')).toBeTruthy()
  })

  it('S41-2: 只读（已结项）项目状态列为彩色徽章；结项弹窗未完任务表按状态着色', async () => {
    await renderDetail(2)
    expect(rowOf('结项已完成任务').querySelector('[data-testid="task-status-badge"][data-tone="ok"]')).toBeTruthy()
    expect(rowOf('结项冻结任务').querySelector('[data-testid="task-status-badge"][data-tone="muted"]')).toBeTruthy()
    expect(rowOf('结项冻结任务').querySelector('select')).toBeNull() // 只读无下拉

    // 结项弹窗（在项目1上打开）：未完 4 条各带状态徽章
    cleanup()
    await renderDetail(1)
    fireEvent.click(screen.getByRole('button', { name: /结项（S8）/ }))
    const modal = await screen.findByText(/结项（S8）：所有任务标记完成后方可结项/)
    const badges = Array.from(document.querySelectorAll('[data-testid="task-status-badge"]') as NodeListOf<HTMLElement>)
      .filter((b) => modal.closest('.fixed')!.contains(b))
    expect(badges.length).toBe(4)
    expect(badges.map((b) => b.dataset.tone).sort()).toEqual(['info', 'info', 'muted', 'muted'])
  })

  it('S42-2: 进度卡渲染分段堆叠条 + 完成 x/y（z%）+ 逾期计数', async () => {
    await renderDetail(1)
    const strip = await screen.findByTestId('progress-strip')
    expect(strip.textContent).toContain('完成 1/5（20%）')
    expect(strip.textContent).toContain('逾期 1')
    expect(strip.querySelectorAll('[data-seg="done"]').length).toBe(1)
    expect(strip.querySelectorAll('[data-seg="doing"]').length).toBe(1)
    expect(strip.querySelectorAll('[data-seg="todo"]').length).toBe(1)
  })

  it('S42-3: 任务甘特——今日线/状态条（逾期红）/月刻度/里程碑菱形/未排期组', async () => {
    await renderDetail(1)
    expect(await screen.findByTestId('task-gantt-today')).toBeTruthy()
    const bars = Array.from(document.querySelectorAll('[data-testid="task-gantt-bar"]') as NodeListOf<HTMLElement>)
    expect(bars.length).toBe(4) // 未排期任务不入轴
    const visuals = bars.map((b) => b.dataset.visual)
    expect(visuals).toContain('doing')
    expect(visuals).toContain('done')
    expect(visuals).toContain('todo') // 只有截止任务=截止旗形态
    expect(visuals).toContain('overdue')
    expect(document.querySelectorAll('[data-testid="task-gantt-tick"]').length).toBeGreaterThanOrEqual(1)
    const ms = Array.from(document.querySelectorAll('[data-testid="milestone-marker"]') as NodeListOf<HTMLElement>)
    expect(ms.map((m) => m.dataset.tone)).toEqual(['muted', 'bad']) // planned / missed
    const un = document.querySelector('[data-testid="task-gantt-unscheduled"]') as HTMLElement
    expect(un.textContent).toContain('未排期任务')
  })

  it('S42-3: 全部任务无日期 → 甘特空态引导而非空白图（未排期组仍列出）', async () => {
    await renderDetail(3)
    expect(await screen.findByText(/暂无可排期任务/)).toBeTruthy()
    expect(screen.queryByTestId('task-gantt-today')).toBeNull()
    const un = document.querySelector('[data-testid="task-gantt-unscheduled"]') as HTMLElement
    expect(un.textContent).toContain('无日期任务甲')
  })

  it('S42-5: 甘特轨道弹性撑满（width 100% + minWidth 兜底横向滚动），今日线 calc 百分比定位', async () => {
    await renderDetail(1)
    const canvas = await screen.findByTestId('task-gantt-canvas')
    expect(canvas.style.width).toBe('100%')
    expect(Number.parseInt(canvas.style.minWidth, 10)).toBeGreaterThan(0)
    const today = screen.getByTestId('task-gantt-today') as HTMLElement
    expect(today.style.left).toContain('calc(')
  })

  it('S43-2: 组合页表格「进度」列与看板卡迷你进度条；tasksTotal=0 不显示', async () => {
    location.hash = '#/projects'
    render(<StoreProvider><Projects view="table" /></StoreProvider>)
    const row = (await screen.findByText('项目甲')).closest('tr')!
    expect(within(row).getByTestId('mini-progress').textContent).toContain('1/5')
    const emptyRow = screen.getByText('空项目').closest('tr')!
    expect(within(emptyRow).queryByTestId('mini-progress')).toBeNull()
    expect(screen.getByRole('columnheader', { name: '进度' })).toBeTruthy()

    cleanup()
    render(<StoreProvider><Projects view="board" /></StoreProvider>)
    await screen.findByText('项目甲')
    expect(document.querySelectorAll('[data-testid="mini-progress"]').length).toBe(1) // 空项目不渲染
  })
})

// PRD S4-8（v0.47）：讨论面事件流分栏——「进展」「风险/阻塞」「财务记录」三固定栏 +
// 其余类型「其他」栏（类型筛选器，默认全显）；栏内业务时间倒序；待确认建议逐条确认入口不变（J4 锚点）。
describe('S4-8 讨论面分栏（v0.47）', () => {
  const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200 })
  const E = (id: number, over: Record<string, unknown>) => ({
    id, projectId: 1, businessTime: 1760000000000 + id * 1000, createdAt: 1760000000000 + id * 1000,
    nature: 'record', summary: '', speakerLabel: null, status: 'effective',
    targetTaskId: null, targetField: null, targetValue: null,
    generatedBy: 'web', sourcePlatform: 'web', confidence: null, ...over,
  })
  const eventsFixture = [
    E(101, { eventType: 'progress', summary: '进展：接口联调完成' }),
    E(102, { eventType: 'risk', summary: '风险：客户验收口径未定' }),
    E(103, { eventType: 'blocker', summary: '阻塞：等客户 VPN 白名单' }),
    E(104, { eventType: 'finance', summary: '财务：首期款已到账' }),
    E(105, { eventType: 'owner_change', summary: '任务「任务一」责任人 未指派 → 李四' }),
    E(106, { eventType: 'decision', summary: '决策：二期范围砍半' }),
    E(107, { eventType: 'status_change', nature: 'suggestion', status: 'pending', summary: '口述：任务一已完成', targetTaskId: 11, targetField: 'status', targetValue: 'done' }),
  ]
  const feedFetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.startsWith('/api/v1/auth/me')) return json({ member: { id: 1, name: '甲', role: 'admin' } })
    if (url.startsWith('/api/v1/projects/1/events')) return json({ events: eventsFixture })
    if (url.startsWith('/api/v1/projects/1')) {
      return json({
        id: 1, name: '项目甲', templateCode: 'lianmai_365', projectTypeId: 1, typeName: '365连麦',
        status: 'active', priority: 'medium', leadMemberId: 1, leadName: '张三', clientName: null,
        planStartDate: '2026-10-09', planEndDate: '2026-11-09', daysToDelivery: 31,
        tasksTotal: 1, tasksDone: 0,
        tasks: [{ id: 11, projectId: 1, title: '任务一', responsibleMemberId: null, responsibleName: null, status: 'todo', planStartDate: '2026-10-09', planEndDate: null, isOverdue: false, refCount: 0 }],
        milestones: [],
      })
    }
    if (url.startsWith('/api/v1/members')) return json({ members: [{ id: 1, name: '张三', status: 'active' }, { id: 2, name: '李四', status: 'active' }] })
    if (url.startsWith('/api/v1/channels')) return json({ channels: [] })
    return json({})
  })
  beforeEach(() => {
    cleanup()
    feedFetch.mockClear()
    globalThis.fetch = feedFetch as unknown as typeof fetch
    location.hash = '#/projects/1'
  })

  it('S4-8: 事件按类型进固定栏（进展/风险·阻塞/财务记录），其余进其他栏', async () => {
    render(<StoreProvider><ProjectDetail id={1} /></StoreProvider>)
    const colProgress = within(await screen.findByTestId('event-col-progress'))
    const colRisk = within(screen.getByTestId('event-col-risk'))
    const colFinance = within(screen.getByTestId('event-col-finance'))
    const colOther = within(screen.getByTestId('event-col-other'))
    expect(colProgress.getByText(/接口联调完成/)).toBeTruthy()
    expect(colRisk.getByText(/验收口径未定/)).toBeTruthy()
    expect(colRisk.getByText(/VPN 白名单/)).toBeTruthy() // 风险与阻塞同栏
    expect(colFinance.getByText(/首期款已到账/)).toBeTruthy()
    expect(colOther.getByText(/责任人 未指派 → 李四/)).toBeTruthy()
    expect(colOther.getByText(/二期范围砍半/)).toBeTruthy()
    // 固定栏类型不落入其他栏；待确认建议在其他栏保留逐条确认入口（J4 锚点）
    expect(colOther.queryByText(/接口联调完成/)).toBeNull()
    expect(colOther.getByRole('button', { name: '确认生效' })).toBeTruthy()
  })

  it('S4-8: 其他栏类型筛选器多选切换（默认全显，点选隐藏/恢复）', async () => {
    render(<StoreProvider><ProjectDetail id={1} /></StoreProvider>)
    const colOther = within(await screen.findByTestId('event-col-other'))
    const chip = colOther.getByRole('button', { name: '决策' })
    expect(chip.getAttribute('aria-pressed')).toBe('true') // 默认全显
    fireEvent.click(chip) // 隐藏「决策」
    expect(colOther.queryByText(/二期范围砍半/)).toBeNull()
    expect(colOther.getByText(/责任人 未指派 → 李四/)).toBeTruthy() // 其余类型不受影响
    fireEvent.click(colOther.getByRole('button', { name: '决策' })) // 恢复
    expect(colOther.getByText(/二期范围砍半/)).toBeTruthy()
  })
})

// S46（v0.51，K29）通知收件箱冒烟：推送记录列表渲染（类型/状态/标题/正文）
describe('S46 通知收件箱（v0.51）', () => {
  it('S46-4: 通知页渲染本人推送记录（类型标签/投递状态/标题/正文）', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('/api/v1/pushes')) {
        return new Response(JSON.stringify({
          pushes: [{
            id: 1, pushType: 'daily_report', title: '项目大脑日报 2026-10-10', body: '【我的任务】未完 3 项',
            status: 'skipped', error: '飞书凭证未配置', createdAt: 1760000000000,
          }],
        }), { status: 200 })
      }
      return new Response(JSON.stringify({ member: { id: 1, name: '甲', role: 'member' } }), { status: 200 })
    }) as unknown as typeof fetch
    location.hash = '#/pushes'
    render(<StoreProvider><App /></StoreProvider>)
    expect(await screen.findByText('项目大脑日报 2026-10-10')).toBeTruthy()
    expect(screen.getByText('日报')).toBeTruthy() // 类型中文标签
    expect(screen.getByText('未投递')).toBeTruthy() // skipped 中文状态
    expect(screen.getByText(/未完 3 项/)).toBeTruthy()
  })
})

// S47（v0.52，K30）LLM 用量摘要冒烟：配置台 LLM 卡片展示近 7 天用量表
describe('S47 LLM 用量记账（v0.52）', () => {
  it('S47-4: 配置台 LLM 卡片展示近 7 天用量摘要（用途/调用数/token/失败）', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('/api/v1/admin/llm-usage')) {
        return new Response(JSON.stringify({
          days: 7,
          byPurpose: [{ purpose: 'extraction', calls: 42, promptTokens: 1000, completionTokens: 200, avgDurationMs: 800, errors: 1 }],
          byDay: [{ day: '2026-10-10', calls: 42, tokens: 1200, errors: 1 }],
        }), { status: 200 })
      }
      if (url.startsWith('/api/v1/admin/settings')) {
        return new Response(JSON.stringify({
          llm: { provider: 'deepseek', deepseek: { apiKey: '', baseUrl: '', model: '' }, 'glm-coding': { apiKey: '', baseUrl: '', model: '' }, timeoutMs: 120000 },
          'im.feishu': { appId: '', appSecret: '' }, calendar: { feishuCalendarId: '' },
        }), { status: 200 })
      }
      return new Response(JSON.stringify({ member: { id: 1, name: '甲', role: 'admin' } }), { status: 200 })
    }) as unknown as typeof fetch
    location.hash = '#/admin/integrations/llm'
    const { default: Admin } = await import('./pages/Admin')
    render(<StoreProvider><Admin section="integrations" tab="llm" /></StoreProvider>)
    const usage = await screen.findByTestId('llm-usage')
    expect(within(usage).getByText('extraction')).toBeTruthy()
    expect(within(usage).getByText('42')).toBeTruthy()
    expect(within(usage).getByText('1000/200')).toBeTruthy()
  })
})
