import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

// 最小 lint 面（engineering-standards §5：lint → typecheck → test）：推荐规则 + react-hooks 规则。
// 类型问题由 tsc 兜底（typecheck 在 CI 先于 lint 跑），这里只抓推荐级错误与 hooks 纪律。
export default [
  { ignores: ['dist/', 'coverage/', 'node_modules/', 'playwright-report/', 'test-results/', 'out/', 'skills/', 'data/', '.zcode/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['server/**/*.{js,mjs}', 'scripts/*.{js,mjs}', 'evals/**/*.mjs'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['e2e/**/*.ts', 'playwright.config.ts', 'vite.config.ts', 'vitest.config.ts'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // 本项目前端为手写 Context store + 「useEffect 里 void refresh()」数据加载惯用法（无外部数据库），
      // react-hooks v6 的 set-state-in-effect 与该惯用法冲突——关闭；exhaustive-deps 保持 error（存量已裁决：K17）。
      'react-hooks/set-state-in-effect': 'off',
    },
  },
  {
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', ignoreRestSiblings: true }],
      '@typescript-eslint/no-explicit-any': 'off', // SPA 手写组件层大量 any，tsc strict 已兜底线
    },
  },
]
