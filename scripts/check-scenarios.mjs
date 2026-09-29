#!/usr/bin/env node
// 需求追踪门禁（engineering-standards §1）：比对 PRD 全部 P0 场景编号是否出现在测试里，缺失即红。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const prd = fs.readFileSync(path.join(ROOT, 'docs/prd.md'), 'utf8')
const p0 = [...prd.matchAll(/场景 (S\d+)（P0）/g)].map((m) => m[1])
if (!p0.length) {
  console.error('check-scenarios: PRD 中未找到 P0 场景（解析失败？）')
  process.exit(1)
}

const testDir = path.join(ROOT, 'server/test')
const testText = fs
  .readdirSync(testDir)
  .filter((f) => f.endsWith('.test.mjs'))
  .map((f) => fs.readFileSync(path.join(testDir, f), 'utf8'))
  .join('\n')

const missing = p0.filter((id) => !new RegExp(`\\b${id}\\b`).test(testText))
if (missing.length) {
  console.error(`check-scenarios: FAIL — P0 场景缺少测试覆盖: ${missing.join(', ')}`)
  process.exit(1)
}
console.log(`check-scenarios: OK — ${p0.length} 个 P0 场景全部有测试锚点（${p0.join(', ')}）`)
