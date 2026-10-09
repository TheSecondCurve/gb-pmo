import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { buildLlmAdapter } from '../brain/llm.js'
import { setupApp, loginCookie, authed } from './helpers.mjs'
import { setSetting } from '../engine/settings.js'
import { DEFAULT_SETTINGS } from '../engine/enums.js'

// PRD S40（v0.43）— LLM 调用超时治理（design.md K22）：超时（AbortController 掐断）自动原样重试一次；
// 仍超时 → 504 中文指引（不透出英文 DOMException 原文）；非超时错误不重试；默认 timeoutMs 60s→120s；
// 配置台 LLM 卡片可编辑超时。线上实证：GLM-5.3-Flash 大 JSON 输出约 117s > 旧默认 60s。

let realFetch
beforeAll(() => { realFetch = globalThis.fetch })
afterAll(() => { globalThis.fetch = realFetch })

/** fetch stub：挂起直到适配层 AbortController 掐断（模拟 undici 的 abort 拒绝行为）。 */
const hangFetch = (calls) => (url, opts) => {
  calls.push(JSON.parse(opts.body))
  return new Promise((_, rej) => {
    opts.signal.addEventListener('abort', () => rej(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })))
  })
}

const okFetch = (calls) => (url, opts) => {
  calls.push(JSON.parse(opts.body))
  return Promise.resolve({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"a":1}' } }] }) })
}

describe('S40 LLM 调用超时治理', () => {
  it('S40-1: 首次超时自动原样重试一次；重试成功则正常返回（恰好两次请求）', async () => {
    const calls = []
    let hangs = 1
    globalThis.fetch = (url, opts) => (hangs-- > 0 ? hangFetch(calls)(url, opts) : okFetch(calls)(url, opts))
    const a = buildLlmAdapter({ provider: 'deepseek', apiKey: 'k', timeoutMs: 20 })
    expect(await a.complete([{ role: 'user', content: 'x' }])).toBe('{"a":1}')
    expect(calls.length).toBe(2)
  })

  it('S40-2: 重试仍超时 → 504 中文指引（含 timeoutMs 与调整入口），无英文 abort 原文；恰好两次请求', async () => {
    const calls = []
    globalThis.fetch = hangFetch(calls)
    const a = buildLlmAdapter({ provider: 'deepseek', apiKey: 'k', timeoutMs: 20 })
    const err = await a.complete([{ role: 'user', content: 'x' }]).catch((e) => e)
    expect(err.statusCode).toBe(504)
    expect(err.message).toContain('超时')
    expect(err.message).toContain('timeoutMs')
    expect(err.message).toContain('20ms')
    expect(err.message).not.toContain('This operation was aborted')
    expect(calls.length).toBe(2) // 不多重试
  })

  it('S40-3: 上游非 2xx 不触发超时重试（502 语义不变）；JSON 模式 400 去参重试不变', async () => {
    const calls = []
    globalThis.fetch = (_url, _opts) => { calls.push(1); return Promise.resolve({ ok: false, status: 500, text: async () => 'upstream boom' }) }
    const a = buildLlmAdapter({ provider: 'deepseek', apiKey: 'k', timeoutMs: 20 })
    await expect(a.complete([{ role: 'user', content: 'x' }])).rejects.toThrow('LLM HTTP 500')
    expect(calls.length).toBe(1)

    // JSON 模式 400 → 去参重试一次（v0.14 既有语义，与超时重试互不干扰）
    const bodies = []
    globalThis.fetch = (url, opts) => {
      const body = JSON.parse(opts.body)
      bodies.push(body.response_format)
      if (body.response_format) return Promise.resolve({ ok: false, status: 400, text: async () => 'response_format unsupported' })
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"a":1}' } }] }) })
    }
    expect(await a.complete([{ role: 'user', content: 'x' }], { json: true })).toBe('{"a":1}')
    expect(bodies).toEqual([{ type: 'json_object' }, undefined])
  })

  it('S40-4: timeoutMs 按配置生效（默认 120s）；setSetting 非法值 400；web 端点透出 504 中文指引', async () => {
    // 默认值 60s → 120s（GLM 大 JSON 实测约 117s）
    expect(DEFAULT_SETTINGS.llm.timeoutMs).toBe(120000)

    const ctx = await setupApp()
    try {
      // 配置校验：非整数/越界（1s~600s）→ 400
      expect(() => setSetting(ctx.db, 'llm', { timeoutMs: 500 }, ctx.members.admin.id)).toThrow(/timeoutMs/)
      expect(() => setSetting(ctx.db, 'llm', { timeoutMs: 601000 }, ctx.members.admin.id)).toThrow(/timeoutMs/)
      expect(() => setSetting(ctx.db, 'llm', { timeoutMs: 1.5 }, ctx.members.admin.id)).toThrow(/timeoutMs/)
      const ok = setSetting(ctx.db, 'llm', { provider: 'deepseek', apiKey: 'fake-key', timeoutMs: 1000 }, ctx.members.admin.id)
      expect(ok.timeoutMs).toBe(1000)

      // 全链路：配置经 getLlm 生效——真实适配器 + 挂起 fetch，web 草案端点应 504 中文指引
      const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
      const p = await authed(ctx.app, cookie, 'POST', '/api/v1/projects', {
        name: '超时项目', templateCode: 'lianmai_365', leadMemberId: ctx.members.lead.id,
      })
      globalThis.fetch = hangFetch([])
      const res = await authed(ctx.app, cookie, 'POST', `/api/v1/projects/${p.body.id}/draft-init-assignments`, {})
      expect(res.status).toBe(504)
      expect(res.body.message).toContain('超时')
      expect(res.body.message).not.toContain('This operation was aborted')
    } finally {
      ctx.db.close()
    }
  })
})
