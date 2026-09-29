import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['server/test/**/*.test.mjs', 'src/**/*.test.{ts,tsx}'],
    environment: 'node',
    testTimeout: 20000,
    coverage: {
      provider: 'v8',
      // K7：核心目录门禁；server/index.mjs 为进程入口、scheduler.js 为定时器接线（集成由部署冒烟覆盖），
      // db/ 为声明与迁移，均不计数
      include: ['server/engine/**', 'server/routes/**', 'server/brain/**', 'server/agent/**'],
      exclude: ['server/db/**', 'server/brain/scheduler.js'],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
})
