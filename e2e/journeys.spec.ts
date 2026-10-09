import { test, expect, type Page } from '@playwright/test'

// 业务旅程 e2e（engineering-standards §3：Playwright 冒烟，独立 workflow 不挡合并）。
// 覆盖 PRD 核心旅程：登录看板（S5）→ 立项（S1）→ 组合页四视图（S30）→ 建议确认闭环（S3/S20-2 同口子）
// → 结项（S8/S29）→ 配置台权限（S17-6）→ AI 助手降级与斜杠（S24-5/S24-6）→ 任务删除（S36）→ 项目硬删除（S37）
// → 类型初始化提示词与 AI 初始分配降级（S38/S39）。
// 数据真理以 API 复核，UI 断言只锚用户可见事实。

const ADMIN = { username: 'admin', password: 'e2e-admin-pass-123' }

async function login(page: Page, account = ADMIN) {
  await page.goto('/')
  await expect(page.getByRole('button', { name: '登录' })).toBeVisible() // 登录页锚点（品牌文案在应用壳里重名）
  await page.getByLabel('用户名').fill(account.username)
  await page.getByLabel('密码').fill(account.password)
  await page.getByRole('button', { name: '登录' }).click()
  await expect(page.getByRole('heading', { name: /全局看板/ })).toBeVisible()
}

/** UI 立项旅程（走真弹窗）：选 365连麦类型预填 14 条任务清单，牵头人=管理员；可带交付日期。 */
async function createProjectViaUi(page: Page, name: string, planEndDate?: string) {
  await page.goto('/#/projects')
  await page.getByRole('button', { name: '+ 立项' }).click()
  await expect(page.getByText('立项（S1）')).toBeVisible()
  await page.getByLabel('项目名 *').fill(name)
  await page.getByLabel(/项目类型/).selectOption({ label: '365连麦（14 项任务）' })
  await page.getByLabel(/牵头人/).selectOption({ label: '管理员' })
  if (planEndDate) await page.getByRole('textbox', { name: /交付日期/ }).fill(planEndDate)
  // 类型预填：任务清单 textarea 出现模板任务（S1-2/S33 预填语义）
  await expect(page.getByRole('textbox', { name: /任务清单/ })).toHaveValue(/按排队顺序筛选连麦用户/)
  await page.getByRole('button', { name: '立项', exact: true }).click()
  await expect(page.getByText('立项成功')).toBeVisible()
}

test('J1 登录 → 全局看板：导航与指标卡可见（S5-1 入口面）', async ({ page }) => {
  await login(page)
  for (const label of ['全局看板', '项目列表', 'AI 助手', '配置台']) {
    await expect(page.getByRole('link', { name: label }).first()).toBeVisible()
  }
  await expect(page.getByText('在跑项目', { exact: true })).toBeVisible()
  await expect(page.getByText('逾期任务', { exact: true })).toBeVisible()
  await expect(page.getByText(/沉默项目（≥7 天无事件）/)).toBeVisible()
})

test('J2 立项旅程：类型清单预填 → 立项 → 详情页任务面 14 项（S1-2/S1-8）', async ({ page }) => {
  await login(page)
  const name = `J2 客户交付 ${Date.now()}`
  await createProjectViaUi(page, name)
  await page.getByRole('link', { name }).first().click()
  await expect(page.getByRole('heading', { name })).toBeVisible()
  await expect(page.getByText('任务面（14）')).toBeVisible()
  await expect(page.getByText('进行中').first()).toBeVisible() // S1-8：立项即进行中
})

test('J3 项目组合页四视图：看板/表格/人员/时间线切换与深链（S30-2/S30-3）', async ({ page }) => {
  await login(page)
  await createProjectViaUi(page, `J3 组合页 ${Date.now()}`, '2026-12-31') // 带交付日期才会入时间轴（S30-3 不虚构日期）
  await page.goto('/#/projects')
  for (const view of ['看板', '表格', '人员', '时间线']) {
    await page.getByRole('link', { name: view, exact: true }).click() // exact：否则会命中导航「全局看板」
    const key = { 看板: 'board', 表格: 'table', 人员: 'people', 时间线: 'timeline' }[view]!
    await expect(page).toHaveURL(new RegExp(`#/projects/${key}`))
  }
  await expect(page.getByText(/时间线（\d+ 有排期 · 今日 \d{4}-\d{2}-\d{2}）/)).toBeVisible()
})

test('J4 建议确认闭环：建议型事件在详情页确认生效，任务状态翻转（S20-2/S24-3 同口子）', async ({ page }) => {
  await login(page)
  const name = `J4 建议 ${Date.now()}`
  await createProjectViaUi(page, name)
  await page.getByRole('link', { name }).first().click()
  const projectId = Number(page.url().match(/projects\/(\d+)/)![1])

  // API 造一条 pending 建议（把首个任务标完成）；UI 只走确认口子
  const detail = await (await page.request.get(`/api/v1/projects/${projectId}`)).json()
  const taskId = detail.tasks[0].id
  const created = await page.request.post(`/api/v1/projects/${projectId}/events`, {
    data: { eventType: 'status_change', nature: 'suggestion', summary: '口述：首任务已完成', targetTaskId: taskId, targetField: 'status', targetValue: 'done' },
  })
  expect(created.status()).toBe(201)

  await page.reload()
  await page.getByRole('button', { name: '确认生效' }).first().click()
  await expect(page.getByText('建议已确认生效')).toBeVisible()
  const after = await (await page.request.get(`/api/v1/projects/${projectId}`)).json()
  expect(after.tasks[0].status).toBe('done')
})

test('J5 结项旅程：全部标记完成 → 结项总结必填 → 归档只读（S8-1/S8-2/S29-2）', async ({ page }) => {
  await login(page)
  const name = `J5 结项 ${Date.now()}`
  await createProjectViaUi(page, name)
  await page.getByRole('link', { name }).first().click()

  await page.getByRole('button', { name: '结项（S8）' }).click()
  await expect(page.getByText(/未完任务 14 项/)).toBeVisible()
  // 总结为空时确认按钮禁用（S29 必填守门）
  await expect(page.getByRole('button', { name: '确认结项' })).toBeDisabled()
  await page.getByRole('button', { name: '全部标记完成' }).click()
  await expect(page.getByText('无未完任务，可直接结项')).toBeVisible()
  await page.getByLabel(/结项总结/).fill('按期交付，复盘完成')
  await page.getByRole('button', { name: '确认结项' }).click()
  await expect(page.getByText('项目已结项归档')).toBeVisible()
  await expect(page.getByText(/结束原因 \/ 复盘记录（已结项 · 只读）/)).toBeVisible()
  await expect(page.getByText('按期交付，复盘完成', { exact: true })).toBeVisible()
})

test('J6 配置台权限：管理员可见可进；普通成员导航无入口、直达被拒（S17-6）', async ({ page }) => {
  await login(page)
  await expect(page.getByRole('link', { name: '配置台' }).first()).toBeVisible()

  // 管理员经 API 建普通成员（成员身份表维护面）
  const res = await page.request.post('/api/v1/members', {
    data: { name: '成员甲', username: `member_${Date.now()}`, password: 'member-pass-123' },
  })
  expect(res.status()).toBe(201)
  const member = (await res.json()).member

  await page.getByRole('button', { name: '退出登录' }).first().click()
  await expect(page.getByRole('button', { name: '登录' })).toBeVisible() // 回到登录页
  await login(page, { username: member.username, password: 'member-pass-123' })
  await expect(page.getByRole('link', { name: '配置台' })).toHaveCount(0)
  await page.goto('/#/admin')
  await expect(page.getByText('需要系统管理员权限')).toBeVisible()
})

test('J7 AI 助手：LLM 未配置回明确指引；/help 与 /new 确定性可用（S24-5/S24-6）', async ({ page }) => {
  await login(page)
  await page.goto('/#/chat')
  await page.getByRole('button', { name: /新会话/ }).first().click()
  const input = page.getByPlaceholder(/试试/)
  await input.fill('你好')
  await page.getByRole('button', { name: '发送' }).click()
  await expect(page.getByText(/系统未配置 LLM，AI 助手暂不可用/)).toBeVisible()

  await input.fill('/help')
  await page.getByRole('button', { name: '发送' }).click()
  await expect(page.getByText(/\/new/).first()).toBeVisible() // web 能力清单含斜杠命令

  await input.fill('/new')
  await page.getByRole('button', { name: '发送' }).click()
  await expect(page.getByText(/不受影响|已清空|新话题/).first()).toBeVisible()
})

test('J8 任务删除旅程：详情页任务面行内删除 → 软删留痕，任务面计数减一（S36）', async ({ page }) => {
  await login(page)
  const name = `J8 删除 ${Date.now()}`
  await createProjectViaUi(page, name)
  await page.getByRole('link', { name }).first().click()
  const projectId = Number(page.url().match(/projects\/(\d+)/)![1])
  await expect(page.getByText('任务面（14）')).toBeVisible()

  // 首条任务标题（API 取真理，复核用）；UI 走行内删除入口，原生 confirm 自动接受
  const before = await (await page.request.get(`/api/v1/projects/${projectId}`)).json()
  const firstTitle = before.tasks[0].title as string
  page.on('dialog', (d) => void d.accept())
  await page.getByRole('button', { name: '删除', exact: true }).first().click()

  await expect(page.getByText('任务已删除（软删留痕）')).toBeVisible()
  await expect(page.getByText('任务面（13）')).toBeVisible()
  // API 复核：已删任务从任务面消失（软删留痕的行保留/审计由 server 场景测试锚定）
  const after = await (await page.request.get(`/api/v1/projects/${projectId}`)).json()
  expect(after.tasks.length).toBe(13)
  expect(after.tasks.some((t: { title: string }) => t.title === firstTitle)).toBe(false)
})

test('J9 项目硬删除旅程：详情页「彻底删除」双重确认 → 项目消失且详情 404（S37）', async ({ page }) => {
  await login(page) // admin（硬删除仅管理员可见/可执行）
  const name = `J9 硬删 ${Date.now()}`
  await createProjectViaUi(page, name)
  await page.getByRole('link', { name }).first().click()
  const projectId = Number(page.url().match(/projects\/(\d+)/)![1])

  // 双重 confirm 自动接受；删除成功跳回项目列表
  page.on('dialog', (d) => void d.accept())
  await page.getByRole('button', { name: '彻底删除' }).click()
  await expect(page.getByText('项目已彻底删除')).toBeVisible()
  await expect(page).toHaveURL(/#\/projects$/)
  await expect(page.getByRole('link', { name })).toHaveCount(0)
  // API 复核：物理删除后详情 404（级联抹除由 server 场景测试锚定）
  expect((await page.request.get(`/api/v1/projects/${projectId}`)).status()).toBe(404)
})

test('J10 类型初始化提示词 + AI 初始分配：提示词保存回读；任务默认未指派；无 LLM 给指引（S38/S39）', async ({ page }) => {
  await login(page) // admin（类型编辑器仅管理员）

  // 配置台类型编辑器：初始化提示词填写保存（S39-1/S39-8）——按行定位 365连麦（首行可能是停用占位类型）
  await page.goto('/#/admin/project/types')
  await page.getByRole('row', { name: /lianmai_365/ }).getByRole('button', { name: '编辑' }).click()
  const prompt = `J10 规则 ${Date.now()}：彩排安排在交付前 3 天`
  await page.getByLabel(/初始化提示词/).fill(prompt)
  await page.getByRole('button', { name: '保存' }).click()
  await expect(page.getByText(/类型已保存/)).toBeVisible()
  // API 复核回读一致
  const types = await (await page.request.get('/api/v1/project-types')).json()
  expect(types.types.find((t: { code: string }) => t.code === 'lianmai_365').initPrompt).toBe(prompt)

  // 立项 → 任务默认未指派（S38-2，与牵头人解耦）；新建行责任人默认空（S38-6）
  const name = `J10 初始分配 ${Date.now()}`
  await createProjectViaUi(page, name)
  await page.getByRole('link', { name }).first().click()
  const projectId = Number(page.url().match(/projects\/(\d+)/)![1])
  const detail = await (await page.request.get(`/api/v1/projects/${projectId}`)).json()
  expect(detail.tasks.every((t: { responsibleMemberId: number | null }) => t.responsibleMemberId === null)).toBe(true)
  await expect(page.getByPlaceholder(/默认未指派/)).toBeVisible()

  // AI 初始分配入口在；e2e 环境无 LLM → 草案 503 给明确指引（S39-3 降级语义，不瞎生成）
  await page.getByRole('button', { name: /AI 初始分配/ }).click()
  await expect(page.getByText(/LLM 未配置/)).toBeVisible()
})
