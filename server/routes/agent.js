// Agent 接入路由（形态 B + 受限 action 端点，K3）
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { issueToken, authenticateToken, audit, revokeToken, listTokens } from '../engine/auth.js'
import { login } from '../engine/auth.js'
import { queryMetric, listMetrics } from '../engine/metrics.js'
import * as tasks from '../engine/tasks.js'
import * as projectTypes from '../engine/projectTypes.js'
import { setSetting } from '../engine/settings.js'
import { safeBaseUrl, renderLoginSh, renderLoginPs1, renderInstallSh, renderInstallPs1, renderClientSh } from '../agent/scripts.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SKILL_VERSION = '0.1.1'

const SQL_MAX_ROWS = 1000
const CREDENTIAL_COLS = /password_hash|token_hash/i
const SESSION_TABLE = /\bsessions\b/i
const READ_HEADS = /^(SELECT|WITH|VALUES)\b/i
const WRITE_HEADS = /^(INSERT|UPDATE|DELETE)\b/i

export function registerAgentRoutes(app) {
  const db = app.db
  const baseUrlOf = (req) => safeBaseUrl(req.headers.host, app.baseUrl)

  // —— 公开端点：授权与安装（零密钥；凭证只在客户本机）——

  app.get('/agent/login.sh', async (req, reply) => {
    reply.header('content-type', 'text/x-shellscript; charset=utf-8')
    return renderLoginSh(baseUrlOf(req), SKILL_VERSION)
  })

  app.get('/agent/login.ps1', async (req, reply) => {
    reply.header('content-type', 'text/plain; charset=utf-8')
    return renderLoginPs1(baseUrlOf(req), SKILL_VERSION)
  })

  app.get('/agent/skill/:name/install.sh', async (req, reply) => {
    if (req.params.name !== 'gb-pmo') return reply.status(404).send({ message: '未知 skill' })
    reply.header('content-type', 'text/x-shellscript; charset=utf-8')
    return renderInstallSh(baseUrlOf(req), SKILL_VERSION)
  })

  app.get('/agent/skill/:name/install.ps1', async (req, reply) => {
    if (req.params.name !== 'gb-pmo') return reply.status(404).send({ message: '未知 skill' })
    reply.header('content-type', 'text/plain; charset=utf-8')
    return renderInstallPs1(baseUrlOf(req), SKILL_VERSION)
  })

  app.get('/agent/skill/:name/SKILL.md', async (req, reply) => {
    if (req.params.name !== 'gb-pmo') return reply.status(404).send({ message: '未知 skill' })
    const file = path.join(app.skillsDir, 'SKILL.md')
    if (!fs.existsSync(file)) return reply.status(404).send({ message: 'SKILL.md 缺失' })
    reply.header('content-type', 'text/markdown; charset=utf-8')
    return fs.readFileSync(file, 'utf8')
  })

  app.get('/agent/skill/:name/client.sh', async (req, reply) => {
    if (req.params.name !== 'gb-pmo') return reply.status(404).send({ message: '未知 skill' })
    reply.header('content-type', 'text/x-shellscript; charset=utf-8')
    return renderClientSh(SKILL_VERSION)
  })

  // PAT 签发（终端授权用；公开但需真实账密）
  app.post('/api/v1/auth/agent-login', async (req, reply) => {
    const { member } = login(db, req.body?.username, req.body?.password)
    const out = issueToken(db, member.id, { scope: 'write', name: 'agent-cli' })
    audit(db, { memberId: member.id, action: 'token.agentLogin', objectType: 'token', objectId: out.id })
    return { token: out.token, scope: out.scope, expiresAt: out.expiresAt, member: { id: member.id, name: member.name } }
  })

  // —— Bearer PAT 端点（cookie 一律 403，鉴权已在 onRequest hook 完成）——

  app.post('/api/v1/agent/sql', async (req, reply) => {
    const { token, member } = req.agentAuth
    const sql = typeof req.body?.sql === 'string' ? req.body.sql : ''
    if (!sql.trim()) return reply.status(400).send({ message: 'sql 必填' })

    // 注释前缀剥离后再判定语句头，防 /* */ 或 -- 前缀绕过
    const stripped = sql.replace(/^\s*(--[^\n]*\n|\/\*[\s\S]*?\*\/|\s)+/, '').trim()
    // 凭据黑名单与 sessions 表引用（prepare 之前判定）
    if (CREDENTIAL_COLS.test(sql) || SESSION_TABLE.test(sql)) {
      audit(db, { memberId: member.id, action: 'agent.sql.denied', detail: { reason: 'blacklist' } })
      return reply.status(403).send({ message: '禁止访问凭据列或 sessions 表' })
    }
    if (/^(CREATE|ALTER|DROP|PRAGMA|ATTACH|DETACH|VACUUM|REINDEX)\b/i.test(stripped)) {
      audit(db, { memberId: member.id, action: 'agent.sql.denied', detail: { reason: 'ddl' } })
      return reply.status(403).send({ message: 'DDL/PRAGMA 对任何令牌一律 403' })
    }
    // S19 时区护栏：裸 date('now')/datetime('now') 是 UTC 语义，凌晨时段会错一天；显式带时区修饰（如 '+8 hours'）放行
    if (/\b(?:date|datetime)\s*\(\s*'now'\s*\)/i.test(sql)) {
      audit(db, { memberId: member.id, action: 'agent.sql.denied', detail: { reason: 'utc_now' } })
      return reply.status(400).send({ message: "date('now')/datetime('now') 为 UTC 语义（凌晨会差一天）：今天请用 BJ_TODAY()（北京时区，可传 epoch 毫秒参数），或显式写 date('now','+8 hours')" })
    }
    const isReadHead = READ_HEADS.test(stripped)
    const isWriteHead = WRITE_HEADS.test(stripped)
    if (!isReadHead && !isWriteHead) {
      return reply.status(403).send({ message: '仅允许 SELECT/WITH/VALUES/INSERT/UPDATE/DELETE 单语句' })
    }

    // 双条件读写判定：stmt.readonly === true 且 以 SELECT/WITH/VALUES 开头，缺一落写分支
    let stmt
    try {
      stmt = db.prepare(sql)
    } catch (e) {
      return reply.status(400).send({ message: `SQL 预编译失败: ${e.message}` })
    }
    const readonlyOk = stmt.readonly === true && isReadHead
    if (!readonlyOk) {
      if (token.scope !== 'write') {
        audit(db, { memberId: member.id, action: 'agent.sql.denied', detail: { reason: 'scope' } })
        return reply.status(403).send({ message: '该令牌为 read scope，不能执行写语句' })
      }
      audit(db, { memberId: member.id, action: 'agent.sql.write', detail: { head: stripped.slice(0, 24) } })
    }

    let result
    try {
      // stmt.reader = 是否返回数据（INSERT/UPDATE/DELETE 走 run，SELECT/WITH 走 all）
      result = stmt.reader ? stmt.all() : stmt.run()
    } catch (e) {
      return reply.status(400).send({ message: `执行失败: ${e.message}` })
    }
    const rows = Array.isArray(result) ? result : []
    const truncated = rows.length > SQL_MAX_ROWS
    const limited = truncated ? rows.slice(0, SQL_MAX_ROWS) : rows
    // 结果列黑名单二次校验
    if (limited.length && Object.keys(limited[0]).some((c) => CREDENTIAL_COLS.test(c))) {
      return reply.status(403).send({ message: '结果包含凭据列' })
    }
    return { rows: limited, count: limited.length, truncated, changes: Array.isArray(result) ? undefined : result.changes }
  })

  app.get('/api/v1/agent/metrics', async () => ({ metrics: listMetrics() }))

  app.post('/api/v1/agent/metrics/query', async (req) => {
    const { metric, params } = req.body || {}
    if (!metric) throw Object.assign(new Error('metric 必填'), { statusCode: 400 })
    return queryMetric(db, metric, params || {})
  })

  app.get('/api/v1/agent/tokens', async (req) => ({ tokens: listTokens(db, req.agentAuth.member.id) }))

  // —— 受限 action 端点（K3 白名单枚举；配置类仅系统管理员 PAT，S17-10）——

  const ACTIONS = {
    // 触发类：write scope 即可
    trigger_extraction: { run: async (params, ctx) => (await import('../brain/extract.js')).runExtraction(db, params) },
    generate_project_digest: { run: async (params, ctx) =>
      (await import('../brain/digest.js')).projectDigest(db, Number(params.projectId), { llm: app.llm }) },
    generate_person_digest: { run: async (params, ctx) =>
      (await import('../brain/digest.js')).personDigest(db, Number(params.memberId ?? ctx.member.id), { llm: app.llm }) },
    push_report: { run: async (params, ctx) => (await import('../brain/report.js')).dailyReport(db, { llm: app.llm, force: true }) },

    // 配置类（S17-10）：与 web 配置台同构（复用 engine 校验与审计），仅系统管理员 PAT
    upsert_channel: {
      adminOnly: true,
      run: async (params, ctx) => tasks.upsertChannel(db, params, ctx.member.id),
    },
    delete_channel: {
      adminOnly: true,
      run: async (params, ctx) => tasks.deleteChannel(db, Number(params.id), ctx.member.id) || { ok: true },
    },
    put_setting: {
      adminOnly: true,
      run: async (params, ctx) => setSetting(db, params.key, params.value, ctx.member.id),
    },
    create_template: {
      adminOnly: true,
      run: async (params, ctx) => projectTypes.createTemplate(db, params, ctx.member.id),
    },
    draft_template_tasks: {
      adminOnly: true,
      run: async (params, ctx) => (await import('../brain/templates.js')).draftTemplateTasks(db, params, { llm: app.llm ?? undefined }),
    },
    reset_channel_cursor: {
      adminOnly: true,
      run: async (params, ctx) => tasks.resetChannelCursor(db, Number(params.channelId), { days: params.days }, ctx.member.id),
    },
  }

  app.post('/api/v1/agent/actions', async (req, reply) => {
    const { token, member } = req.agentAuth
    if (token.scope !== 'write') return reply.status(403).send({ message: '触发类操作需要 write scope' })
    const { action, params } = req.body || {}
    const spec = ACTIONS[action]
    if (!spec) {
      audit(db, { memberId: member.id, action: 'agent.action.denied', detail: { action } })
      return reply.status(400).send({ message: `未知 action: ${action}（白名单: ${Object.keys(ACTIONS).join(', ')}）` })
    }
    if (spec.adminOnly && member.role !== 'admin') {
      audit(db, { memberId: member.id, action: 'agent.action.denied', detail: { action, reason: 'adminOnly' } })
      return reply.status(403).send({ message: '配置类操作需要系统管理员的 PAT（web 配置台或换管理员账号授权）' })
    }
    const result = await spec.run(params || {}, { member })
    audit(db, { memberId: member.id, action: `agent.action.${action}`, detail: { params: params || {} } })
    return { ok: true, action, result }
  })

  return app
}
