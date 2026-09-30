#!/usr/bin/env node
// gb-pmo 入口：建库迁移 → bootstrap 管理员（零 admin 缺密码拒启）→ 起服务（生产托管 dist/）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDb } from './db/index.mjs'
import { buildApp } from './routes/app.js'
import { bootstrapAdmin } from './engine/auth.js'
import { getLlm } from './brain/llm.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const PORT = Number(process.env.PORT || 8086)
const DB_FILE = process.env.GB_PMO_DB || path.join(ROOT, 'data/gb-pmo.db')

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true })
const db = createDb(DB_FILE)

const bootstrapped = bootstrapAdmin(db, {
  username: process.env.GB_PMO_ADMIN_USER,
  password: process.env.GB_PMO_ADMIN_PASS,
  name: process.env.GB_PMO_ADMIN_NAME || '管理员',
})
if (bootstrapped) console.log('[bootstrap] 管理员已创建')

const app = buildApp(db, {
  baseUrl: process.env.GB_PMO_BASE_URL || `http://127.0.0.1:${PORT}`,
  logger: true,
  llm: undefined, // 让 brain 各模块按 settings 动态解析（getLlm(db, undefined)）
})

// 生产模式：Fastify 进程直接托管前端 dist/（单进程交付物）
const DIST = path.join(ROOT, 'dist')
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json',
}
app.setNotFoundHandler((req, reply) => {
  if (req.raw.url?.startsWith('/api/') || req.raw.url?.startsWith('/agent/')) {
    return reply.status(404).send({ message: 'Not Found' })
  }
  const rel = req.raw.url.split('?')[0]
  const file = path.join(DIST, rel)
  if (rel !== '/' && file.startsWith(DIST) && fs.existsSync(file) && fs.statSync(file).isFile()) {
    return reply.header('content-type', MIME[path.extname(file)] || 'application/octet-stream').send(fs.readFileSync(file))
  }
  const index = path.join(DIST, 'index.html')
  if (fs.existsSync(index)) {
    return reply.header('content-type', 'text/html; charset=utf-8').send(fs.readFileSync(index))
  }
  return reply.status(404).send({ message: 'dist/ 未构建' })
})

await app.listen({ port: PORT, host: '0.0.0.0' })
console.log(`gb-pmo listening on :${PORT} (db: ${DB_FILE})`)

// 大脑调度器随进程默认运行（S18，v0.7）：cron 与每任务 enabled 开关在配置台「阈值与推送」热调整
const { startScheduler } = await import('./brain/scheduler.js')
startScheduler(db, { llm: getLlm(db) })
console.log('[scheduler] enabled（cron 由配置台 scheduler 块驱动：信息更新对齐 / 预警提醒 / 日报提醒）')
