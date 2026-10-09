#!/usr/bin/env node
// 需求追踪门禁（engineering-standards §1），三层比对，缺失即红：
//   ① PRD 全部顶层 P0 场景（场景 S\d+（P0））必须出现在测试文本里；
//   ② scenarios.md 登记的逐条子验收标准（S\d+-\d+，含标注「已废弃」的保留编号）必须出现在测试文本里；
//   ③ PRD 顶层 P0 场景必须在 scenarios.md 有对应章节（镜像防漂移）。
// 测试文本 = server/test/*.test.mjs + src/**/*.test.{ts,tsx}（S19-4/S30 等前端锚点也参与比对）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const prd = fs.readFileSync(path.join(ROOT, 'docs/prd.md'), 'utf8')
const p0 = [...new Set([...prd.matchAll(/场景 (S\d+)（P0）/g)].map((m) => m[1]))]
if (!p0.length) {
  console.error('check-scenarios: PRD 中未找到 P0 场景（解析失败？）')
  process.exit(1)
}

const scenariosPath = path.join(ROOT, 'docs/scenarios.md')
const scenarios = fs.readFileSync(scenariosPath, 'utf8')
const subIds = [...new Set([...scenarios.matchAll(/\bS\d+-\d+\b/g)].map((m) => m[0]))]
const scenarioSections = new Set([...scenarios.matchAll(/^## (S\d+)\b/gm)].map((m) => m[1]))

// 汇总全部测试文本（server 场景层 + 前端测试）
function collectTests(dir, pattern) {
  const out = []
  const walk = (d) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name)
      if (f.isDirectory()) walk(p)
      else if (pattern.test(f.name)) out.push(fs.readFileSync(p, 'utf8'))
    }
  }
  walk(dir)
  return out
}
const testText = [
  ...collectTests(path.join(ROOT, 'server/test'), /\.test\.mjs$/),
  ...collectTests(path.join(ROOT, 'src'), /\.test\.(ts|tsx)$/),
].join('\n')

let fail = 0
const inTests = (id) => new RegExp(`\\b${id}\\b`).test(testText)

// ① 顶层 P0 场景 → 测试
const missingP0 = p0.filter((id) => !inTests(id))
if (missingP0.length) {
  console.error(`check-scenarios: FAIL ① — P0 场景缺少测试锚点: ${missingP0.join(', ')}`)
  fail = 1
}

// ② 子验收标准 → 测试（逐条）
const missingSub = subIds.filter((id) => !inTests(id))
if (missingSub.length) {
  console.error(`check-scenarios: FAIL ② — scenarios.md 子验收标准缺少测试锚点: ${missingSub.join(', ')}`)
  fail = 1
}

// ③ PRD 顶层 P0 场景 → scenarios.md 章节
const missingSection = p0.filter((id) => !scenarioSections.has(id))
if (missingSection.length) {
  console.error(`check-scenarios: FAIL ③ — P0 场景在 scenarios.md 无章节: ${missingSection.join(', ')}`)
  fail = 1
}

if (fail) process.exit(1)
console.log(
  `check-scenarios: OK — ${p0.length} 个 P0 场景、${subIds.length} 条子验收标准全部有测试锚点（顶层: ${p0.join(', ')}）`
)
