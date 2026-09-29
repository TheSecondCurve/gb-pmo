// LLM 适配层（D8：DeepSeek，OpenAI 兼容）。换模型=改配置，不引额外网关组件（design.md K5/偏离#5）。
// 大脑各模块统一走 getLlm(db, override)：测试注入 fake，未配置 apiKey 时返回 null（走确定性降级）。

import { getSetting } from '../engine/settings.js'

export function deepseekAdapter(cfg) {
  const base = String(cfg.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '')
  return {
    name: 'deepseek',
    async complete(messages, { json = false, temperature = 0.2 } = {}) {
      const ctl = new AbortController()
      const timer = setTimeout(() => ctl.abort(), cfg.timeoutMs || 60000)
      try {
        const res = await fetch(`${base}/chat/completions`, {
          method: 'POST',
          signal: ctl.signal,
          headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
          body: JSON.stringify({
            model: cfg.model || 'deepseek-chat',
            messages,
            temperature,
            ...(json ? { response_format: { type: 'json_object' } } : {}),
          }),
        })
        if (!res.ok) {
          const text = await res.text().catch(() => '')
          throw Object.assign(new Error(`LLM HTTP ${res.status}: ${text.slice(0, 200)}`), { statusCode: 502 })
        }
        const data = await res.json()
        return data.choices?.[0]?.message?.content ?? ''
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

/** 统一入口：优先注入的 override（测试/调用方），其次按配置构建 DeepSeek，未配置返回 null。 */
export function getLlm(db, override) {
  if (override !== undefined) return override
  const cfg = getSetting(db, 'llm')
  if (!cfg.apiKey) return null
  return deepseekAdapter(cfg)
}

/** S17-4 测试连接：发一次最小 completion，回显成败原因。 */
export async function testLlmConnection(cfg) {
  if (!cfg.apiKey || !cfg.baseUrl) return { ok: false, reason: '未配置 apiKey/baseUrl' }
  try {
    const adapter = deepseekAdapter({ ...cfg, timeoutMs: Math.min(cfg.timeoutMs || 60000, 15000) })
    const out = await adapter.complete([{ role: 'user', content: 'ping，请只回复 pong' }], { temperature: 0 })
    return { ok: true, sample: String(out).slice(0, 80) }
  } catch (e) {
    return { ok: false, reason: e.name === 'AbortError' ? '超时' : e.message }
  }
}

/** 从 LLM 输出解析 JSON（容忍 markdown 代码块包裹）。 */
export function parseJsonLoose(text) {
  if (!text) return null
  const trimmed = String(text).trim().replace(/^```(json)?\s*/i, '').replace(/```\s*$/, '')
  try {
    return JSON.parse(trimmed)
  } catch {
    const m = trimmed.match(/[[{][\s\S]*[\]}]/)
    if (m) {
      try { return JSON.parse(m[0]) } catch { return null }
    }
    return null
  }
}
