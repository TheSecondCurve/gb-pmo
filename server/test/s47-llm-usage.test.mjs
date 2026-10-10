import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getLlm } from '../brain/llm.js'
import { llmUsage } from '../engine/llmUsage.js'
import { setupApp, setupDb, loginCookie, authed } from './helpers.mjs'
import { setSetting } from '../engine/settings.js'
import { createProject } from '../engine/projects.js'
import { createMember } from '../engine/members.js'
import { ingestMessages } from '../brain/extract.js'

// PRD S47（v0.52，K30）— LLM 用量记账：getLlm 适配器统一包裹记账层，每次逻辑调用落一行 llm_calls；
// 一次调用一行（S40 内部重试不重复计）；管理端按用途聚合 + 按日汇总。

let realFetch
beforeAll(() => { realFetch = globalThis.fetch })
afterAll(() => { globalThis.fetch = realFetch })

const okFetchWithUsage = () =>
  Promise.resolve({
    ok: true, status: 200,
    json: async () => ({ choices: [{ message: { content: '{"events":[]}' } }], usage: { prompt_tokens: 11, completion_tokens: 22 } }),
  })

describe('S47 LLM 用量记账', () => {
  it('S47-1: getLlm 包裹的适配器每次逻辑调用落一行；fake 注入同样落行；内部重试不重复计', async () => {
    const { db } = setupDb()
    // fake 注入路径（对话面等同构）
    const fake = { name: 'fake', complete: async () => '{"events":[]}' }
    const a = getLlm(db, fake, { purpose: 'chat' })
    await a.complete([{ role: 'user', content: 'x' }])
    let rows = db.prepare('SELECT * FROM llm_calls').all()
    expect(rows.length).toBe(1)
    expect(rows[0].purpose).toBe('chat')
    expect(rows[0].ok).toBe(1)
    expect(typeof rows[0].duration_ms).toBe('number')

    // 真实适配器路径：库内配置 + fetch stub；首次超时重试成功 → 仍只落一行
    setSetting(db, 'llm', { provider: 'deepseek', apiKey: 'k', timeoutMs: 1000 })
    let hangs = 1
    globalThis.fetch = (url, opts) => hangs-- > 0
      ? new Promise((_, rej) => opts.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))))
      : okFetchWithUsage()
    const real = getLlm(db, undefined, { purpose: 'digest', projectId: 7 })
    const out = await real.complete([{ role: 'user', content: 'x' }], { json: true })
    expect(out).toBe('{"events":[]}')
    rows = db.prepare('SELECT * FROM llm_calls ORDER BY id').all()
    expect(rows.length).toBe(2) // 一次逻辑调用一行，S40 内部重试不重复计
    expect(rows[1].purpose).toBe('digest')
    expect(rows[1].project_id).toBe(7)
    expect(rows[1].provider).toBe('deepseek')
    expect(rows[1].ok).toBe(1)
    expect(rows[1].prompt_tokens).toBe(11) // S47-2：上游 usage 记账
    expect(rows[1].completion_tokens).toBe(22)
    globalThis.fetch = realFetch
    db.close()
  })

  it('S47-2: 调用失败落 ok=0 + error 摘要；无 usage 字段时 token 容忍为空', async () => {
    const { db } = setupDb()
    const badFake = { name: 'bad', complete: async () => { throw new Error('LLM HTTP 500: upstream down') } }
    const a = getLlm(db, badFake, { purpose: 'extraction', projectId: 3 })
    await expect(a.complete([{ role: 'user', content: 'x' }])).rejects.toThrow('500')
    const row = db.prepare('SELECT * FROM llm_calls').get()
    expect(row.ok).toBe(0)
    expect(row.error).toContain('500')
    expect(row.prompt_tokens).toBeNull()
    db.close()
  })

  it('S47-1: 抽取链路（ingestMessages）经 getLlm 解析，落 purpose=extraction 且带渠道项目 id', async () => {
    const { db } = setupDb()
    const lead = createMember(db, { name: '牵头', username: 'lead1', password: 'p' }, 1)
    const p = createProject(db, { name: '记账项目', typeCode: 'lianmai_365', leadMemberId: lead.id }, lead.id)
    const fake = { name: 'fake', complete: async () => '{"events":[{"nature":"record","eventType":"progress","summary":"联调完成"}]}' }
    await ingestMessages(db, { platform: 'feishu', channelType: 'dedicated', projectId: p.id }, [
      { id: 'm1', ts: Date.now(), speakerId: '', speakerLabel: '张三', text: '接口联调完成了' },
    ], { llm: fake })
    const rows = db.prepare('SELECT * FROM llm_calls').all()
    expect(rows.length).toBe(1)
    expect(rows[0].purpose).toBe('extraction')
    expect(rows[0].project_id).toBe(p.id)
    db.close()
  })

  it('S47-3: 管理端按用途聚合 + 按日汇总；普通成员 403', async () => {
    const ctx = await setupApp()
    const { db } = ctx
    const fake = { name: 'fake', complete: async () => 'ok' }
    await getLlm(db, fake, { purpose: 'extraction' }).complete([])
    await getLlm(db, fake, { purpose: 'extraction' }).complete([])
    await getLlm(db, fake, { purpose: 'chat' }).complete([])
    const bad = getLlm(db, { name: 'b', complete: async () => { throw new Error('x') } }, { purpose: 'chat' })
    await bad.complete([]).catch(() => {})

    const adminCookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
    const res = await authed(ctx.app, adminCookie, 'GET', '/api/v1/admin/llm-usage?days=7')
    expect(res.status).toBe(200)
    const extraction = res.body.byPurpose.find((r) => r.purpose === 'extraction')
    expect(extraction.calls).toBe(2)
    const chat = res.body.byPurpose.find((r) => r.purpose === 'chat')
    expect(chat.calls).toBe(2)
    expect(chat.errors).toBe(1)
    expect(res.body.byDay.length).toBe(1) // 全部落在今天（北京日）
    expect(res.body.byDay[0].calls).toBe(4)

    const devCookie = await loginCookie(ctx.app, 'lisi', 'pass-123456')
    const res2 = await authed(ctx.app, devCookie, 'GET', '/api/v1/admin/llm-usage')
    expect(res2.status).toBe(403)
    ctx.db.close()
  })

  it('S47-5: LLM 未配置时 getLlm 返回 null 且不产生用量行；llmUsage 空库返回空聚合', async () => {
    const { db } = setupDb()
    expect(getLlm(db, undefined, { purpose: 'chat' })).toBeNull()
    expect(db.prepare('SELECT COUNT(*) AS n FROM llm_calls').get().n).toBe(0)
    const usage = llmUsage(db, { days: 7 })
    expect(usage.byPurpose).toEqual([])
    expect(usage.byDay).toEqual([])
    db.close()
  })
})
