// LLM 适配层（D8：多类别 OpenAI 兼容薄适配，v0.14）。换模型=改配置，不引额外网关组件（design.md K5/偏离#5）。
// 类别目录在 engine/enums.js（LLM_PROVIDERS）：deepseek（默认，存量配置无感兼容）/ glm-coding（GLM 国内 Coding Plan）。
// 大脑各模块统一走 getLlm(db, override)：测试注入 fake，未配置 apiKey 时返回 null（走确定性降级）。

import { getSetting } from '../engine/settings.js'
import { LLM_PROVIDERS } from '../engine/enums.js'

/** 按类别构建适配器（S17-11）：未填 baseUrl/model 时取类别默认；未知类别 400。 */
export function buildLlmAdapter(cfg) {
  const provider = cfg.provider || 'deepseek'
  const meta = LLM_PROVIDERS[provider]
  if (!meta) {
    throw Object.assign(new Error(`未知 llm.provider: ${provider}（须为 ${Object.keys(LLM_PROVIDERS).join(' / ')}）`), { statusCode: 400 })
  }
  const base = String(cfg.baseUrl || meta.baseUrl).replace(/\/+$/, '')
  const model = cfg.model || meta.model
  return {
    name: provider,
    async complete(messages, { json = false, temperature = 0.2 } = {}) {
      const ask = async (extra) => {
        const ctl = new AbortController()
        const timer = setTimeout(() => ctl.abort(), cfg.timeoutMs || 60000)
        try {
          const res = await fetch(`${base}/chat/completions`, {
            method: 'POST',
            signal: ctl.signal,
            headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
            body: JSON.stringify({ model, messages, temperature, ...extra }),
          })
          if (!res.ok) {
            const text = await res.text().catch(() => '')
            throw Object.assign(new Error(`LLM HTTP ${res.status}: ${text.slice(0, 200)}`), { statusCode: 502, upstreamStatus: res.status })
          }
          const data = await res.json()
          return data.choices?.[0]?.message?.content ?? ''
        } finally {
          clearTimeout(timer)
        }
      }
      if (!json) return ask({})
      try {
        return await ask({ response_format: { type: 'json_object' } })
      } catch (e) {
        // GLM 编码端点对 response_format 无官方承诺：仅 400 时去参重试一次（提示词已要求 JSON，parseJsonLoose 兜底）
        if (e.upstreamStatus === 400) return ask({})
        throw e
      }
    },
  }
}

/** 旧名保留（存量测试引用）：等价 buildLlmAdapter({ ...cfg, provider: 'deepseek' })。 */
export function deepseekAdapter(cfg) {
  return buildLlmAdapter({ ...cfg, provider: 'deepseek' })
}

/** 统一入口：优先注入的 override（测试/调用方），其次按配置构建——v0.15 起按类别分开存储，
 *  生效类别（cfg.provider）未配 apiKey 返回 null（走确定性降级），另一类别已配不顶用。 */
export function getLlm(db, override) {
  if (override !== undefined) return override
  const cfg = getSetting(db, 'llm')
  const sub = cfg[cfg.provider] ?? {}
  if (!sub.apiKey) return null
  return buildLlmAdapter({ provider: cfg.provider, ...sub, timeoutMs: cfg.timeoutMs })
}

/** S17-4 测试连接：按类别（未填 baseUrl/model 取默认）发一次最小 completion，回显成败原因。 */
export async function testLlmConnection(cfg) {
  if (!cfg.apiKey) return { ok: false, reason: '未配置 apiKey' }
  try {
    const adapter = buildLlmAdapter({ ...cfg, timeoutMs: Math.min(cfg.timeoutMs || 60000, 15000) })
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
