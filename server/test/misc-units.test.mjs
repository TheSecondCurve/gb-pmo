import { describe, it, expect, afterEach } from 'vitest'
import { setupDb } from './helpers.mjs'
import { parseJsonLoose, deepseekAdapter, buildLlmAdapter, getLlm, testLlmConnection } from '../brain/llm.js'
import { routeMessage } from '../brain/routing.js'
import * as feishu from '../brain/connectors/feishu.js'
import * as wecom from '../brain/connectors/wecom.js'
import { safeBaseUrl } from '../agent/scripts.mjs'
import { listPushes, notifyMember } from '../brain/push.js'
import { label, values, assertValue, ENUMS } from '../engine/enums.js'
import { getSetting, setSetting, getAllSettings } from '../engine/settings.js'
import { createMember } from '../engine/members.js'

// 单元补齐：LLM 解析/适配器、分拣降级、连接器（fetch 桩）、脚本渲染安全、推送/枚举/配置

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

describe('llm.js', () => {
  it('parseJsonLoose：裸 JSON / 代码块包裹 / 嵌入文本 / 垃圾输入', () => {
    expect(parseJsonLoose('{"a":1}')).toEqual({ a: 1 })
    expect(parseJsonLoose('```json\n{"a":2}\n```')).toEqual({ a: 2 })
    expect(parseJsonLoose('结果是 {"a":3} 请查收')).toEqual({ a: 3 })
    expect(parseJsonLoose('完全不是 JSON')).toBeNull()
    expect(parseJsonLoose('')).toBeNull()
  })

  it('deepseekAdapter：成功解析 choices；HTTP 错误带状态码', async () => {
    globalThis.fetch = async (url, opts) => ({
      ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'pong' } }] }),
    })
    const a = deepseekAdapter({ baseUrl: 'https://api.deepseek.com/', apiKey: 'k', model: 'm' })
    expect(await a.complete([{ role: 'user', content: 'ping' }])).toBe('pong')
    expect(a.name).toBe('deepseek')

    globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => 'unauthorized' })
    await expect(a.complete([{ role: 'user', content: 'x' }])).rejects.toThrow('LLM HTTP 401')
  })

  it('testLlmConnection：缺配置 / 成功', async () => {
    expect((await testLlmConnection({})).reason).toContain('未配置')
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'pong' } }] }) })
    const ok = await testLlmConnection({ baseUrl: 'http://x', apiKey: 'k' })
    expect(ok.ok).toBe(true)
  })

  // S17-11（PRD v0.14）：GLM 国内 Coding Plan 类别——官方 OpenAI 兼容编码端点 + 默认模型 + 可覆写
  it('S17-11: glm-coding 适配器按类别默认端点/模型发请求；baseUrl/model 可覆写；Bearer 鉴权', async () => {
    const calls = []
    globalThis.fetch = async (url, opts) => {
      calls.push({ url, auth: opts.headers?.authorization, body: JSON.parse(opts.body) })
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'pong' } }] }) }
    }
    const a = buildLlmAdapter({ provider: 'glm-coding', apiKey: 'sk-glm' })
    expect(a.name).toBe('glm-coding')
    expect(await a.complete([{ role: 'user', content: 'ping' }])).toBe('pong')
    expect(calls[0].url).toBe('https://open.bigmodel.cn/api/coding/paas/v4/chat/completions')
    expect(calls[0].body.model).toBe('glm-5.3')
    expect(calls[0].auth).toBe('Bearer sk-glm')

    await buildLlmAdapter({ provider: 'glm-coding', apiKey: 'k', baseUrl: 'http://x/', model: 'glm-5.3-Flash' })
      .complete([{ role: 'user', content: 'x' }])
    expect(calls[1].url).toBe('http://x/chat/completions')
    expect(calls[1].body.model).toBe('glm-5.3-Flash')
  })

  it('S17-11: JSON 模式被端点拒绝（400）时自动去参重试一次；其他 400 不重试', async () => {
    const bodies = []
    globalThis.fetch = async (url, opts) => {
      const body = JSON.parse(opts.body)
      bodies.push(body.response_format)
      if (body.response_format) return { ok: false, status: 400, text: async () => 'response_format unsupported' }
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"a":1}' } }] }) }
    }
    const a = buildLlmAdapter({ provider: 'glm-coding', apiKey: 'k' })
    expect(await a.complete([{ role: 'user', content: 'x' }], { json: true })).toBe('{"a":1}')
    expect(bodies).toEqual([{ type: 'json_object' }, undefined])

    globalThis.fetch = async () => ({ ok: false, status: 400, text: async () => 'bad model' })
    await expect(a.complete([{ role: 'user', content: 'x' }])).rejects.toThrow('LLM HTTP 400')
  })

  it('S17-11: 未知 provider 构建/测试连接均明确失败；testLlmConnection 缺 baseUrl 时按类别默认补齐', async () => {
    expect(() => buildLlmAdapter({ provider: 'nope', apiKey: 'k' })).toThrow('llm.provider')
    const bad = await testLlmConnection({ provider: 'nope', apiKey: 'k' })
    expect(bad.ok).toBe(false)
    expect(bad.reason).toContain('llm.provider')

    const urls = []
    globalThis.fetch = async (url) => { urls.push(url); return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'pong' } }] }) } }
    const ok = await testLlmConnection({ provider: 'glm-coding', apiKey: 'k' }) // 未填 baseUrl
    expect(ok.ok).toBe(true)
    expect(urls[0]).toBe('https://open.bigmodel.cn/api/coding/paas/v4/chat/completions')
  })
})

describe('routing.js 降级（无 LLM）', () => {
  it('项目名/客户名关键词命中；无项目返回 null', async () => {
    const { db } = setupDb()
    createMember(db, { name: '张', username: 'z', password: 'p' }, 1)
    db.prepare(`INSERT INTO projects (name, template_code, status, priority, lead_member_id, client_name, created_at, updated_at)
      VALUES ('官网改版', 'custom', 'active', 'high', 1, '华信集团', 0, 0)`).run()
    const hit = await routeMessage(db, { text: '华信集团的官网改版今天上线' })
    expect(hit.projectId).toBe(1)
    expect(hit.confidence).toBe(0.5)
    const miss = await routeMessage(db, { text: ' unrelated ' })
    expect(miss.projectId).toBeNull()

    const { db: empty } = setupDb()
    expect((await routeMessage(empty, { text: 'x' })).projectId).toBeNull()
    empty.close()
    db.close()
  })
})

describe('连接器（fetch 桩）', () => {
  it('feishu：token + 分页拉取 + 文本归一', async () => {
    let tokenCalled = 0, page = 0
    globalThis.fetch = async (url) => {
      const s = String(url)
      if (s.includes('tenant_access_token')) {
        tokenCalled++
        return { ok: true, json: async () => ({ code: 0, tenant_access_token: 't-123' }) }
      }
      page++
      return {
        ok: true,
        json: async () => ({
          code: 0,
          data: page === 1
            ? { has_more: true, page_token: 'p2', items: [
                { message_id: 'm1', msg_type: 'text', create_time: '1000', sender: { id: 'ou_1' }, body: { content: '{"text":"你好"}' } },
                { message_id: 'm2', msg_type: 'post', create_time: '1001', sender: { id: 'ou_2' }, body: { content: '{"zh_cn":{"title":"纪要","content":[[{"text":"第一条"},{"text":"第二条"}]]}}' } },
              ] }
            : { has_more: false, items: [
                { message_id: 'm3', msg_type: 'interactive', create_time: '1002', sender: { id: 'ou_3' }, body: { content: '{"elements":[{"text":{"text":"卡片内容"}}]}' } },
              ] },
        }),
      }
    }
    const out = await feishu.fetchMessages({ appId: 'a', appSecret: 's' }, { groupKey: 'oc_x' }, null)
    expect(tokenCalled).toBe(1)
    expect(out.messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3'])
    expect(out.messages[0].text).toBe('你好')
    expect(out.messages[1].text).toContain('纪要')
    expect(out.messages[2].text).toContain('卡片内容')
    expect(out.nextCursor).toBe('1002')

    globalThis.fetch = async () => ({ ok: false, status: 400, json: async () => ({ code: 9999, msg: '权限不足' }) })
    await expect(feishu.fetchMessages({ appId: 'a', appSecret: 's' }, { groupKey: 'x' }, null)).rejects.toThrow()
    expect((await feishu.testConnection({ appId: 'a', appSecret: 's' })).ok).toBe(false)
    expect((await feishu.testConnection({})).reason).toContain('A.1')
  })

  it('wecom：缺配置给出附录 A.2 指引；SDK 代理不可达回显原因', async () => {
    await expect(wecom.fetchMessages({}, { groupKey: 'g' }, null)).rejects.toThrow('A.2')
    globalThis.fetch = async () => { throw new Error('ECONNREFUSED') }
    const res = await wecom.testConnection({ corpId: 'c', secret: 's', privateKey: 'k', sdkUrl: 'http://127.0.0.1:9' })
    expect(res.ok).toBe(false)
    expect(res.reason).toContain('不可达')
    const noSdk = await wecom.testConnection({ corpId: 'c', secret: 's', privateKey: 'k' })
    expect(noSdk.reason).toContain('C SDK')
  })
})

describe('agent 脚本安全', () => {
  it('safeBaseUrl：Host 白名单外的值回退 127.0.0.1，防 shell 注入', () => {
    expect(safeBaseUrl('evil.example.com; rm -rf', 'http://pmo.internal:8086')).toBe('http://127.0.0.1:8086')
    expect(safeBaseUrl('$(whoami)', 'http://pmo.internal:8086')).toBe('http://127.0.0.1:8086')
    expect(safeBaseUrl('unknown.host', 'http://pmo.internal:8086')).toBe('http://127.0.0.1:8086')
    expect(safeBaseUrl('pmo.internal:8086', 'http://pmo.internal:8086')).toBe('http://pmo.internal:8086')
    expect(safeBaseUrl('localhost:8086', 'http://pmo.internal:8086')).toBe('http://localhost:8086')
    expect(safeBaseUrl(null, 'http://pmo.internal:8086')).toBe('http://pmo.internal:8086')
  })
})

describe('push / enums / settings 单元', () => {
  it('notifyMember + listPushes：无 IM 身份标 skipped，按人过滤', () => {
    const { db } = setupDb()
    const m = createMember(db, { name: '李', username: 'li', password: 'p' }, 1)
    notifyMember(db, m, { pushType: 'alert', title: 't', body: 'b' })
    const rows = listPushes(db, { recipientMemberId: m.id })
    expect(rows[0].status).toBe('skipped')
    expect(listPushes(db).length).toBe(1)
    db.close()
  })

  it('枚举双向对齐：值↔label；非法值 400', () => {
    expect(label('priority', 'high')).toBe('高')
    expect(values('taskStatus')).toEqual(['todo', 'doing', 'done']) // v0.6 固定三档
    expect(Object.keys(ENUMS.projectStatus).length).toBe(5)
    expect(() => assertValue('priority', 'urgent')).toThrow()
    expect(assertValue('channelPlatform', 'feishu')).toBe('feishu')
  })

  it('settings：未知 key 拒绝；深合并覆盖；getAllSettings 带 _updatedAt', () => {
    const { db } = setupDb()
    expect(() => getSetting(db, 'nope')).toThrow()
    setSetting(db, 'thresholds', { silentDays: 3 }, 1)
    expect(getSetting(db, 'thresholds').silentDays).toBe(3)
    expect(getSetting(db, 'thresholds').keypersonMaxProjects).toBe(3) // 默认值仍在
    const all = getAllSettings(db)
    expect(all.llm.model).toBe('deepseek-chat')
    expect(all._updatedAt.thresholds).toBeTruthy()
    expect(() => setSetting(db, 'nope', {}, 1)).toThrow()
    db.close()
  })

  it('S17-11: llm.provider 校验与向后兼容——未知值 400；存量无 provider 行按 deepseek；getLlm 按类别构建', () => {
    const { db } = setupDb()
    expect(getSetting(db, 'llm').provider).toBe('deepseek') // 默认类别
    expect(() => setSetting(db, 'llm', { provider: 'nope' }, 1)).toThrow(/llm\.provider/)
    const saved = setSetting(db, 'llm', { provider: 'glm-coding', apiKey: 'sk-glm' }, 1)
    expect(saved.baseUrl).toBe('https://open.bigmodel.cn/api/coding/paas/v4') // 未填按类别默认补齐
    expect(getLlm(db).name).toBe('glm-coding')
    // 归一化分支：自定义 baseUrl 保留；空值回填类别默认；value 缺 provider 时沿用已存类别
    const custom = setSetting(db, 'llm', { provider: 'glm-coding', apiKey: 'k', baseUrl: 'http://my-proxy', model: 'glm-5.3-Flash' }, 1)
    expect(custom.baseUrl).toBe('http://my-proxy')
    expect(custom.model).toBe('glm-5.3-Flash')
    const refilled = setSetting(db, 'llm', { provider: 'glm-coding', apiKey: 'k', baseUrl: '', model: '' }, 1)
    expect(refilled.baseUrl).toBe('https://open.bigmodel.cn/api/coding/paas/v4')
    expect(refilled.model).toBe('glm-5.3')
    const kept = setSetting(db, 'llm', { apiKey: 'k2' }, 1)
    expect(kept.provider).toBe('glm-coding')
    expect(kept.baseUrl).toBe('https://open.bigmodel.cn/api/coding/paas/v4')
    // 存量部署兼容：老配置行没有 provider 字段 → 按 deepseek 解释
    db.prepare("UPDATE settings SET value = ? WHERE key = 'llm'").run(
      JSON.stringify({ baseUrl: 'https://api.deepseek.com', apiKey: 'sk-ds', model: 'deepseek-chat', timeoutMs: 60000 })
    )
    expect(getLlm(db).name).toBe('deepseek')
    // 未配置 apiKey → null（大脑走确定性降级）
    db.prepare("UPDATE settings SET value = ? WHERE key = 'llm'").run(JSON.stringify({ provider: 'glm-coding' }))
    expect(getLlm(db)).toBeNull()
    db.close()
  })
})
