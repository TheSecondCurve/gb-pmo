import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getLlm } from '../brain/llm.js'
import { setupDb } from './helpers.mjs'
import { setSetting } from '../engine/settings.js'

// PRD S51（v0.56，K34）— LLM 模型分层：llm.purposeModels 按用途覆盖 provider/model

let realFetch
let lastBody
beforeAll(() => {
  realFetch = globalThis.fetch
  globalThis.fetch = (url, opts) => {
    lastBody = JSON.parse(opts.body)
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{}' } }] }) })
  }
})
afterAll(() => { globalThis.fetch = realFetch })

describe('S51 模型分层（按用途覆盖）', () => {
  it('S51-1: purposeModels.extraction 命中覆盖 → 抽取用覆盖模型；其余用途维持主模型', async () => {
    const { db } = setupDb()
    setSetting(db, 'llm', { provider: 'glm-coding', apiKey: 'k', model: 'glm-5.3' })
    setSetting(db, 'llm', { purposeModels: { extraction: { model: 'glm-5.3-Flash' } } })

    await getLlm(db, undefined, { purpose: 'extraction' }).complete([{ role: 'user', content: 'x' }])
    expect(lastBody.model).toBe('glm-5.3-Flash') // 覆盖生效（provider 缺省=当前生效类别）

    await getLlm(db, undefined, { purpose: 'chat' }).complete([{ role: 'user', content: 'x' }])
    expect(lastBody.model).toBe('glm-5.3') // 未覆盖用途维持主模型

    // 用量行带实际生效 model（S47 台账可对比分层效果）
    const rows = db.prepare('SELECT purpose, provider, model FROM llm_calls ORDER BY id').all()
    expect(rows[0]).toMatchObject({ purpose: 'extraction', provider: 'glm-coding', model: 'glm-5.3-Flash' })
    expect(rows[1]).toMatchObject({ purpose: 'chat', provider: 'glm-coding', model: 'glm-5.3' })
    db.close()
  })

  it('S51-2: purposeModels 非法条目（未知 purpose / 未知 provider / 空 model）→ 400 指明字段', async () => {
    const { db } = setupDb()
    expect(() => setSetting(db, 'llm', { purposeModels: { hack: { model: 'm' } } })).toThrowError(/purpose/)
    expect(() => setSetting(db, 'llm', { purposeModels: { extraction: { provider: 'openai', model: 'm' } } })).toThrowError(/provider/)
    expect(() => setSetting(db, 'llm', { purposeModels: { extraction: { model: '' } } })).toThrowError(/model/)
    db.close()
  })

  it('S51-3: 覆盖类别未配 apiKey → 回退当前生效类别（功能不被禁用）', async () => {
    const { db } = setupDb()
    setSetting(db, 'llm', { provider: 'deepseek', apiKey: 'k' }) // glm-coding 无 key
    setSetting(db, 'llm', { purposeModels: { extraction: { provider: 'glm-coding', model: 'glm-5.3-Flash' } } })
    const llm = getLlm(db, undefined, { purpose: 'extraction' })
    expect(llm).not.toBeNull() // 回退而非 null
    await llm.complete([{ role: 'user', content: 'x' }])
    expect(lastBody.model).toBe('deepseek-chat') // 回退主类别主模型
    const row = db.prepare('SELECT provider, model FROM llm_calls').get()
    expect(row.provider).toBe('deepseek') // 按实际生效类别记账
    db.close()
  })

  it('S51-4: 无覆盖时行为与 v0.52 一致（模型=生效类别配置）', async () => {
    const { db } = setupDb()
    setSetting(db, 'llm', { provider: 'glm-coding', apiKey: 'k' }) // 默认模型 glm-5.3
    await getLlm(db, undefined, { purpose: 'extraction' }).complete([{ role: 'user', content: 'x' }])
    expect(lastBody.model).toBe('glm-5.3')
    db.close()
  })
})
