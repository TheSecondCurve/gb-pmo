import { defineConfig } from '@playwright/test'

// e2e 层（engineering-standards §3：Playwright 冒烟不挡合并，独立 workflow 跑）。
// webServer 起真实生产形态（build + 单进程托管 dist/ + 真 SQLite 临时库），
// 管理员经 GB_PMO_ADMIN_* 环境变量 bootstrap；global-setup 每次运行重置 e2e 库。
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  retries: 1, // 吸收时序抖动；连续失败才是信号
  workers: 1, // 单库串行：旅程用例共享一个 e2e 库（唯一命名避免相互污染）
  reporter: [['list'], ['html', { open: 'never' }]],
  globalSetup: './e2e/global-setup.ts',
  use: { baseURL: 'http://127.0.0.1:8099', locale: 'zh-CN' },
  webServer: {
    command: 'npm run build && node server/index.mjs',
    env: {
      NODE_ENV: 'production',
      PORT: '8099',
      GB_PMO_DB: 'data/e2e.db',
      GB_PMO_ADMIN_USER: 'admin',
      GB_PMO_ADMIN_PASS: 'e2e-admin-pass-123',
      GB_PMO_ADMIN_NAME: '管理员',
      GB_PMO_SESSION_SECRET: 'e2e-session-secret-padded-to-32bytes!!',
    },
    url: 'http://127.0.0.1:8099/api/v1/health',
    timeout: 180_000,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
