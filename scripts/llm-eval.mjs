#!/usr/bin/env node
// LLM 协议遵从 eval（非 CI，offline 门禁）——用真实系统提示 + 真实模型验证「每轮只输出一个 JSON 动作」协议。
// 背景：v0.38 线上实测 GLM-5.3-Flash 多轮工具调用后偶发直接输出中文散文（内容对、信封丢），
// 运行时的分层降级（S20-21）只是兜底；本 eval 用于在换模型/换端点/改提示词后主动量化漂移。
//
// 用法：
//   node scripts/llm-eval.mjs                       # 读 --db 指定的库配置（默认 data/gb-pmo.db 的 llm 设置）
//   LLM_API_KEY=xxx LLM_PROVIDER=glm-coding node scripts/llm-eval.mjs   # 环境变量优先（不入库）
// 退出码：有 FAIL 级用例 → 1；全 PASS/WARN → 0。WARN=散文透出（降级层会接住，但计入漂移）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const argValue = (flag) => {
  const i = process.argv.indexOf(flag)
  return i > 0 ? process.argv[i + 1] : undefined
}

const { createDb } = await import(path.join(ROOT, 'server/db/index.mjs'))
const { buildLlmAdapter, getLlm, parseJsonLoose } = await import(path.join(ROOT, 'server/brain/llm.js'))
const { buildSystemPrompt } = await import(path.join(ROOT, 'server/brain/bot/command.js'))

const KNOWN_ACTIONS = new Set(['query', 'metric', 'brief', 'morning', 'recent_chat', 'write', 'reply', 'clarify'])

function verdict(raw) {
  const parsed = parseJsonLoose(raw)
  if (parsed && typeof parsed === 'object' && KNOWN_ACTIONS.has(parsed.action)) return 'PASS'
  if (parsed && typeof parsed === 'object' && typeof parsed.text === 'string' && parsed.text.trim()) return 'WARN' // 缺 action 的半成品
  const t = String(raw ?? '').trim()
  if (t && !t.startsWith('{') && !t.startsWith('[')) return 'WARN' // 裸散文（S20-21 降级会透出）
  return 'FAIL' // 空输出 / 破碎 JSON
}

async function main() {
  const dbFile = argValue('--db') || 'data/gb-pmo.db'
  const db = createDb(fs.existsSync(dbFile) ? dbFile : ':memory:')

  const llm = process.env.LLM_API_KEY
    ? buildLlmAdapter({
        provider: process.env.LLM_PROVIDER || 'deepseek',
        apiKey: process.env.LLM_API_KEY,
        baseUrl: process.env.LLM_BASE_URL,
        model: process.env.LLM_MODEL,
      })
    : getLlm(db)
  if (!llm) {
    console.error(`未找到 LLM 配置（${dbFile} 的 llm 设置无 apiKey）；或用 LLM_API_KEY 环境变量传入。`)
    process.exit(2)
  }

  const systemPrompt = buildSystemPrompt(db, {
    member: { id: 1, name: '评估员', role: 'admin' },
    channel: null,
    chatType: 'p2p',
    surface: 'im',
  })

  const cases = JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/llm-protocol/cases.json'), 'utf8'))
  console.log(`llm-eval: provider=${llm.name} model=${process.env.LLM_MODEL || '（配置默认）'}，共 ${cases.length} 条用例\n`)

  let fails = 0
  let warns = 0
  for (const c of cases) {
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: c.user },
    ]
    const rounds = []
    let worst = 'PASS'
    try {
      for (let round = 0; round < 3; round++) {
        const out = await llm.complete(messages, { temperature: 0.2 })
        const v = verdict(out)
        rounds.push(v)
        if (v === 'FAIL') worst = 'FAIL'
        else if (v === 'WARN' && worst === 'PASS') worst = 'WARN'
        const parsed = parseJsonLoose(out)
        // 模型要查询就喂一条假工具结果继续（模拟多轮）；其余动作即终态
        if (parsed?.action === 'query' && c.toolResult && round < 2) {
          messages.push({ role: 'assistant', content: out }, { role: 'user', content: `工具结果：${c.toolResult}` })
          continue
        }
        break
      }
    } catch (e) {
      rounds.push(`ERROR: ${e.message}`)
      worst = 'FAIL'
    }
    if (worst === 'FAIL') fails += 1
    if (worst === 'WARN') warns += 1
    console.log(`${worst === 'PASS' ? '✅' : worst === 'WARN' ? '⚠️ ' : '❌'} ${c.name}：${rounds.join(' → ')}${c.note ? `\n   ${c.note}` : ''}`)
  }
  console.log(`\n结果：${cases.length - fails - warns} PASS / ${warns} WARN / ${fails} FAIL`)
  db.close()
  process.exit(fails ? 1 : 0)
}

await main()
