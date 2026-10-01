import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDb } from '../db/index.mjs'
import { createMember } from '../engine/members.js'

/** 每个测试文件独立临时真 SQLite 库（不 mock 数据库，engineering-standards §3）。 */
export function setupDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-pmo-test-'))
  const file = path.join(dir, 'test.db')
  const db = createDb(file)
  return { db, dir, file }
}

export function seedMembers(db) {
  const admin = createMember(db, { name: '管理员', username: 'admin', password: 'admin-pass-123', role: 'admin' }, 1)
  const lead = createMember(db, { name: '张三', username: 'zhangsan', password: 'pass-123456', feishuId: 'fs_zhang', wecomId: 'wk_zhang', team: '交付部' }, 1)
  const dev = createMember(db, { name: '李四', username: 'lisi', password: 'pass-123456', feishuId: 'fs_li' }, 1)
  const key = createMember(db, { name: '王五', username: 'wangwu', password: 'pass-123456', wecomId: 'wk_wang', isKeyPerson: 1, maxParallelProjects: 2 }, 1)
  return { admin, lead, dev, key }
}

/** 组装测试应用：真库 + 完整路由栈（inject 调用，不 listen）。额外 opts（如 loggerInstance）透传 buildApp。 */
export async function setupApp({ baseUrl = 'http://pmo.test', ...opts } = {}) {
  const { db, dir } = setupDb()
  const members = seedMembers(db)
  const { buildApp } = await import('../routes/app.js')
  const app = buildApp(db, { baseUrl, cookieSecret: 'unit-test-cookie-secret-32bytes!!', ...opts })
  await app.ready()
  return { app, db, dir, members }
}

/** 登录拿 cookie（inject 层面直接取 Set-Cookie）。 */
export async function loginCookie(app, username, password) {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password } })
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`)
  const set = res.headers['set-cookie']
  const cookie = Array.isArray(set) ? set[0] : set
  return cookie.split(';')[0]
}

export async function authed(app, cookie, method, url, payload) {
  const res = await app.inject({ method, url, payload, headers: { cookie } })
  return { status: res.statusCode, body: res.json() }
}
