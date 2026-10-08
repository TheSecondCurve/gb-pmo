import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getSessionMember, authenticateToken } from '../engine/auth.js'
import { registerApiRoutes } from './api.js'
import { registerAgentRoutes } from './agent.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../..')

const PUBLIC_API = new Set(['/api/v1/auth/login', '/api/v1/auth/agent-login', '/api/v1/health'])

export function buildApp(db, opts = {}) {
  // loggerInstance：注入自定义 logger（测试用）；Fastify 5 不再接受 logger 传实例
  const app = Fastify(
    opts.loggerInstance ? { loggerInstance: opts.loggerInstance } : { logger: opts.logger ?? false }
  )

  const cookieSecret = opts.cookieSecret || process.env.GB_PMO_SESSION_SECRET || ''
  if (cookieSecret.length < 32) {
    throw new Error('GB_PMO_SESSION_SECRET 必须至少 32 位（安全启动检查）')
  }
  app.register(cookie, { secret: cookieSecret })

  app.decorate('db', db)
  app.decorate('baseUrl', opts.baseUrl || process.env.GB_PMO_BASE_URL || 'http://127.0.0.1:8086')
  app.decorate('skillsDir', opts.skillsDir || path.join(ROOT, 'skills/gb-pmo'))
  app.decorate('llm', opts.llm ?? null) // 大脑注入点（测试传 fake；生产不注入，各模块按 settings 动态解析）
  app.decorate('botSync', opts.botSync ?? null) // 机器人热同步注入点（S20-12：测试传 fake；生产不注入，路由走真实 syncBot）
  app.decorate('backupFetch', opts.backupFetch ?? null) // 备份 S3 请求注入点（S34：测试传假 fetch；生产不注入走真实网络）
  app.decorateRequest('member', null)
  app.decorateRequest('agentAuth', null)

  // 统一错误映射：engine 抛出的 statusCode + 附加字段（openTasks / missingTasks 等）
  app.setErrorHandler((err, req, reply) => {
    const status = err.statusCode || 500
    const extra = {}
    for (const k of ['openTasks', 'missingTasks', 'missingProjects']) if (err[k]) extra[k] = err[k]
    if (status >= 500) req.log.error(err) // S22-6：5xx 必落 error 日志（logger 关闭时 req.log 为空操作，无副作用）
    reply.status(status).send({ message: err.message, ...extra })
  })

  // 鉴权：/agent/* 公开资产；/api/v1/agent/* 仅 Bearer PAT（cookie 一律 403）；其余 /api/* 会话
  app.addHook('onRequest', async (req, reply) => {
    const url = req.raw.url || ''
    if (url.startsWith('/agent/')) return
    if (PUBLIC_API.has(url)) return
    if (!url.startsWith('/api/')) return // 静态资源由生产入口单独处理

    if (url.startsWith('/api/v1/agent/')) {
      if (req.cookies['pmo_session']) return reply.status(403).send({ message: 'Agent 端点不接受 cookie，仅 Bearer PAT' })
      const auth = req.headers.authorization || ''
      const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null
      const res = bearer ? req.server.db && authenticateToken(req.server.db, bearer) : null
      if (!res) return reply.status(401).send({ message: '无效或过期的 PAT' })
      req.agentAuth = res
      return
    }

    const raw = req.cookies['pmo_session']
    const uns = raw ? app.unsignCookie(raw) : null
    const member = uns?.valid ? getSessionMember(db, uns.value) : null
    if (!member) return reply.status(401).send({ message: '未登录' })
    req.member = member
  })

  registerApiRoutes(app)
  registerAgentRoutes(app)

  app.get('/api/v1/health', async () => ({ ok: true }))

  return app
}
