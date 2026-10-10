// LLM 适配层（D8：多类别 OpenAI 兼容薄适配，v0.14）。换模型=改配置，不引额外网关组件（design.md K5/偏离#5）。
// 类别目录在 engine/enums.js（LLM_PROVIDERS）：deepseek（默认，存量配置无感兼容）/ glm-coding（GLM 国内 Coding Plan）。
// 大脑各模块统一走 getLlm(db, override, meta)：测试注入 fake，未配置 apiKey 时返回 null（走确定性降级）。
// S47（v0.52，K30）：getLlm 第三参带用途元信息（{purpose, projectId}），返回的适配器统一包裹用量记账——
// 每次逻辑 complete() 落一行 llm_calls（S40 内部重试不重复计）；fake 注入同样被包裹；记账失败不阻塞调用。

import { getSetting } from '../engine/settings.js'
import { LLM_PROVIDERS, DEFAULT_SETTINGS } from '../engine/enums.js'

/** S47：用量台账落行（旁观语义——写库失败只告警不阻塞调用）。 */
function logLlmCall(db, meta, { provider = null, model = null, usage = null, ok, error = null, durationMs = null }) {
  try {
    db.prepare(
      'INSERT INTO llm_calls (purpose, project_id, provider, model, prompt_tokens, completion_tokens, duration_ms, ok, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(meta.purpose, meta.projectId ?? null, provider, model,
      usage?.prompt_tokens ?? null, usage?.completion_tokens ?? null, durationMs, ok ? 1 : 0, error, Date.now())
  } catch (e) {
    console.warn('[llm] 用量记账失败（不影响调用）:', e.message)
  }
}

/** S47：注入的 fake 适配器包装——用量语义与供应商无关（无上游 usage，token 记 NULL）。 */
function wrapUsage(db, adapter, meta) {
  return {
    ...adapter,
    async complete(messages, opts) {
      const started = Date.now()
      try {
        const out = await adapter.complete(messages, opts)
        logLlmCall(db, meta, { provider: adapter.name ?? null, ok: 1, durationMs: Date.now() - started })
        return out
      } catch (e) {
        logLlmCall(db, meta, { provider: adapter.name ?? null, ok: 0, error: String(e?.message || e).slice(0, 300), durationMs: Date.now() - started })
        throw e
      }
    },
  }
}

/** 按类别构建适配器（S17-11）：未填 baseUrl/model 时取类别默认；未知类别 400。
 *  S47：hooks.onDone({ ok, error, usage, durationMs }）在每次逻辑调用结束时回调一次（内部重试不重复触发）。 */
export function buildLlmAdapter(cfg, { onDone } = {}) {
  const provider = cfg.provider || 'deepseek'
  const meta = LLM_PROVIDERS[provider]
  if (!meta) {
    throw Object.assign(new Error(`未知 llm.provider: ${cfg.provider}（须为 ${Object.keys(LLM_PROVIDERS).join(' / ')}）`), { statusCode: 400 })
  }
  const base = String(cfg.baseUrl || meta.baseUrl).replace(/\/+$/, '')
  const model = cfg.model || meta.model
  return {
    name: provider,
    async complete(messages, { json = false, temperature = 0.2 } = {}) {
      const timeoutMs = cfg.timeoutMs || DEFAULT_SETTINGS.llm.timeoutMs
      const startedAt = Date.now()
      let usage = null
      const done = (ok, error) => {
        try { onDone?.({ ok, error, usage, durationMs: Date.now() - startedAt }) } catch { /* 记账回调不阻塞 */ }
      }
      const attempt = async (extra) => {
        const ctl = new AbortController()
        const timer = setTimeout(() => ctl.abort(), timeoutMs)
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
          usage = data.usage ?? null // S47：上游返回 token 用量时记账（无则容忍空）
          return data.choices?.[0]?.message?.content ?? ''
        } finally {
          clearTimeout(timer)
        }
      }
      // S40（v0.43，K22）：超时（AbortController 掐断）自动原样重试一次——覆盖瞬时抖动/上游排队；
      // 仍超时抛 504 中文指引（不透出英文 DOMException 原文）。非超时错误一概不重试。
      const ask = async (extra) => {
        try {
          return await attempt(extra)
        } catch (e) {
          if (e.name !== 'AbortError') throw e
          try {
            return await attempt(extra)
          } catch (e2) {
            if (e2.name !== 'AbortError') throw e2
            throw Object.assign(
              new Error(`LLM 响应超时（已自动重试一次，每次上限 ${timeoutMs}ms）：上游未在限时内返回完整结果——可稍后重试，或在配置台「外部依赖 → LLM」调大超时（llm.timeoutMs，当前 ${timeoutMs}ms）`),
              { statusCode: 504 },
            )
          }
        }
      }
      try {
        if (!json) {
          const out = await ask({})
          done(1, null)
          return out
        }
        try {
          const out = await ask({ response_format: { type: 'json_object' } })
          done(1, null)
          return out
        } catch (e) {
          // GLM 编码端点对 response_format 无官方承诺：仅 400 时去参重试一次（提示词已要求 JSON，parseJsonLoose 兜底）
          if (e.upstreamStatus === 400) {
            const out = await ask({})
            done(1, null)
            return out
          }
          throw e
        }
      } catch (e) {
        done(0, String(e?.message || e).slice(0, 300))
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
 *  生效类别（cfg.provider）未配 apiKey 返回 null（走确定性降级），另一类别已配不顶用。
 *  S47（v0.52，K30）：meta = { purpose, projectId? }——给出 purpose 即启用用量记账
 *  （真实适配器经 onDone 回调带 token 用量；fake 注入经 wrapUsage 包裹，token 记 NULL）。 */
export function getLlm(db, override, meta = {}) {
  if (override !== undefined) return override && meta.purpose ? wrapUsage(db, override, meta) : override
  const cfg = getSetting(db, 'llm')
  const sub = cfg[cfg.provider] ?? {}
  if (!sub.apiKey) return null
  return buildLlmAdapter(
    { provider: cfg.provider, ...sub, timeoutMs: cfg.timeoutMs },
    meta.purpose
      ? { onDone: (info) => logLlmCall(db, meta, { provider: cfg.provider, model: sub.model || LLM_PROVIDERS[cfg.provider]?.model, ...info }) }
      : {},
  )
}

/** S17-4 测试连接：按类别（未填 baseUrl/model 取默认）发一次最小 completion，回显成败原因。 */
export async function testLlmConnection(cfg) {
  if (!cfg.apiKey) return { ok: false, reason: '未配置 apiKey' }
  try {
    const adapter = buildLlmAdapter({ ...cfg, timeoutMs: Math.min(cfg.timeoutMs || DEFAULT_SETTINGS.llm.timeoutMs, 15000) })
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
