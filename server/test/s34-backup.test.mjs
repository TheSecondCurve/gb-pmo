// S34（v0.35）SQLite 定时异地备份：S3 兼容存储配置 + 三步探针连通性 + 在线快照 gzip 上传 + 云端滚动保留。
// 测试经注入假 fetch（fakeS3）走真实签名与请求构造路径，不发出真实网络（engineering-standards §3 真 SQLite 库）。
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { setupDb, setupApp, loginCookie, authed } from './helpers.mjs'
import { getSetting, setSetting } from '../engine/settings.js'
import { signAwsV4 } from '../engine/s3.js'
import { runBackup, testBackupConnection, listBackupHistory } from '../engine/backup.js'
import { dueTasks, startScheduler } from '../brain/scheduler.js'

const CFG = {
  endpoint: 'https://oss-cn-hangzhou.aliyuncs.com',
  region: '',
  bucket: 'gb-pmo-test',
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  prefix: 'backups/',
  pathStyle: false,
  keepCount: 30,
}

/** 假 S3 服务：记录请求（method/url/auth/body），按对象桶状态应答 PUT/GET/HEAD/DELETE。 */
function fakeS3({ putStatus = 200, objects = [] } = {}) {
  const state = { objects: [...objects] }
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url)
    const key = decodeURIComponent(u.pathname).replace(/^\//, '')
    calls.push({ method: init.method, url: u, path: decodeURIComponent(u.pathname), auth: init.headers?.authorization, body: init.body })
    if (init.method === 'PUT') {
      if (putStatus !== 200) {
        return new Response('<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>', { status: putStatus })
      }
      state.objects.push(key)
      return new Response('', { status: 200 })
    }
    if (init.method === 'DELETE') {
      state.objects = state.objects.filter((k) => k !== key)
      return new Response(null, { status: 204 }) // undici：204 响应体必须为 null
    }
    if (init.method === 'HEAD') return new Response('', { status: 200 })
    if (init.method === 'GET') {
      const prefix = u.searchParams.get('prefix') || ''
      const matching = state.objects.filter((k) => k.startsWith(prefix))
      const xml = `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>${matching
        .map((k) => `<Contents><Key>${k}</Key></Contents>`)
        .join('')}</ListBucketResult>`
      return new Response(xml, { status: 200 })
    }
    return new Response('', { status: 400 })
  }
  return { fetchImpl, calls, state }
}

describe('S34 备份配置与签名', () => {
  it('S34-1: 配置校验——endpoint 非 http(s)/keepCount 越界/pathStyle 非布尔/backupCron 非法均 400 指明字段；prefix 归一化', () => {
    const { db } = setupDb()
    expect(() => setSetting(db, 'backup', { endpoint: 'ftp://x' }, 1)).toThrow(/endpoint/)
    expect(() => setSetting(db, 'backup', { endpoint: 'not-a-url' }, 1)).toThrow(/endpoint/)
    expect(() => setSetting(db, 'backup', { keepCount: 0 }, 1)).toThrow(/keepCount/)
    expect(() => setSetting(db, 'backup', { keepCount: 366 }, 1)).toThrow(/keepCount/)
    expect(() => setSetting(db, 'backup', { pathStyle: 'yes' }, 1)).toThrow(/pathStyle/)
    expect(() => setSetting(db, 'scheduler', { backupCron: '99 * * *' }, 1)).toThrow(/cron/)
    expect(() => setSetting(db, 'scheduler', { backupEnabled: 'on' }, 1)).toThrow(/backupEnabled/)
    // 前缀归一化：去首斜杠、补尾斜杠（已有尾斜杠不动；空串保持空=桶根）
    setSetting(db, 'backup', { prefix: '/dbbak' }, 1)
    expect(getSetting(db, 'backup').prefix).toBe('dbbak/')
    setSetting(db, 'backup', { prefix: 'x/' }, 1)
    expect(getSetting(db, 'backup').prefix).toBe('x/')
    setSetting(db, 'backup', { prefix: '' }, 1)
    expect(getSetting(db, 'backup').prefix).toBe('')
    db.close()
  })

  it('S34-2: SigV4 签名与 AWS 官方文档示例向量一致（get-vanilla，防实现回归）', () => {
    const auth = signAwsV4({
      method: 'GET',
      canonicalUri: '/',
      query: '',
      service: 'service',
      region: 'us-east-1',
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
      headers: { host: 'example.amazonaws.com', 'x-amz-date': '20150830T123600Z' },
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    })
    expect(auth).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, ' +
        'SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31'
    )
  })
})

describe('S34 路由（权限 + 测试连通性 + 立即备份 + 历史）', () => {
  it('S34-1: 普通成员四个端点全 403；管理员保存配置成功', async () => {
    const { app, db } = await setupApp()
    const admin = await loginCookie(app, 'admin', 'admin-pass-123')
    const dev = await loginCookie(app, 'lisi', 'pass-123456')
    for (const [m, u] of [
      ['PUT', '/api/v1/admin/settings/backup'],
      ['POST', '/api/v1/admin/backup/test'],
      ['POST', '/api/v1/admin/backup/run'],
      ['GET', '/api/v1/admin/backup/history'],
    ]) {
      expect((await authed(app, dev, m, u, {})).status).toBe(403)
    }
    const r = await authed(app, admin, 'PUT', '/api/v1/admin/settings/backup', { ...CFG, prefix: 'pmo' })
    expect(r.status).toBe(200)
    expect(r.body.value.prefix).toBe('pmo/') // 归一化回显
    db.close()
  })

  it('S34-2: 测试连通性——HEAD 桶 + PUT/DELETE 探针三步；virtual-hosted 寻址与 SigV4 头；写被拒回明确原因；未配全回配置指引', async () => {
    const s3 = fakeS3()
    const { app, db } = await setupApp({ backupFetch: s3.fetchImpl })
    const admin = await loginCookie(app, 'admin', 'admin-pass-123')
    await authed(app, admin, 'PUT', '/api/v1/admin/settings/backup', CFG)
    const r = await authed(app, admin, 'POST', '/api/v1/admin/backup/test', {})
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
    expect(s3.calls.map((c) => c.method)).toEqual(['HEAD', 'PUT', 'DELETE'])
    // virtual-hosted 风格（bucket.endpoint）+ SigV4 凭证头（region 从 endpoint 推断为 oss-cn-hangzhou）
    expect(s3.calls[0].url.host).toBe('gb-pmo-test.oss-cn-hangzhou.aliyuncs.com')
    expect(s3.calls[0].auth.startsWith('AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/202')).toBe(true)
    expect(s3.calls[0].auth.includes('/oss-cn-hangzhou/s3/aws4_request')).toBe(true)
    // 探针对象落前缀下且清理
    expect(s3.calls[1].path).toBe('/backups/.gb-pmo-probe.txt')
    expect(s3.state.objects).toEqual([])
    // 未保存的表单值可直接先测（body 覆盖 bucket，同 S17-4 语义）
    const r2 = await authed(app, admin, 'POST', '/api/v1/admin/backup/test', { bucket: 'another-bucket' })
    expect(r2.body.ok).toBe(true)
    expect(s3.calls.at(-1).url.host.startsWith('another-bucket.')).toBe(true)
    db.close()

    // 写权限被拒 → 明确原因（HTTP 状态 + 指引）
    const s3bad = fakeS3({ putStatus: 403 })
    const ctx2 = await setupApp({ backupFetch: s3bad.fetchImpl })
    const admin2 = await loginCookie(ctx2.app, 'admin', 'admin-pass-123')
    await authed(ctx2.app, admin2, 'PUT', '/api/v1/admin/settings/backup', CFG)
    const rb = await authed(ctx2.app, admin2, 'POST', '/api/v1/admin/backup/test', {})
    expect(rb.body.ok).toBe(false)
    expect(rb.body.reason).toMatch(/写入|403/)
    ctx2.db.close()

    // 未配全 → 不发网络直接回指引（engine 直调断言零网络）
    const none = await testBackupConnection({ ...CFG, bucket: '' }, { fetchImpl: () => { throw new Error('不应发网络请求') } })
    expect(none.ok).toBe(false)
    expect(none.reason).toMatch(/bucket/)
  })

  it('S34-3: 立即备份——gzip 快照上传（key=前缀+北京时刻戳）、解压后为完整 SQLite 库、审计与历史可读', async () => {
    const s3 = fakeS3()
    const { app, db } = await setupApp({ backupFetch: s3.fetchImpl })
    db.prepare(
      `INSERT INTO projects (name, template_code, status, priority, lead_member_id, created_at, updated_at)
       VALUES ('备份验证项目', 'custom', 'active', 'medium', 1, ?, ?)`
    ).run(Date.now(), Date.now())
    const admin = await loginCookie(app, 'admin', 'admin-pass-123')
    await authed(app, admin, 'PUT', '/api/v1/admin/settings/backup', CFG)
    const r = await authed(app, admin, 'POST', '/api/v1/admin/backup/run', {})
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
    expect(r.body.key).toMatch(/^backups\/gb-pmo-\d{8}-\d{6}\.db\.gz$/)
    expect(r.body.bytes).toBeGreaterThan(0)
    const put = s3.calls.find((c) => c.method === 'PUT' && c.path.endsWith('.db.gz'))
    expect(put).toBeTruthy()
    // gzip 魔数 + 解压后为 SQLite 库且含备份前写入的数据
    const bytes = Buffer.from(put.body)
    expect(bytes[0]).toBe(0x1f)
    expect(bytes[1]).toBe(0x8b)
    const raw = zlib.gunzipSync(bytes)
    expect(raw.subarray(0, 15).toString('utf8')).toBe('SQLite format 3')
    const snapFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 's34-verify-')), 'snap.db')
    fs.writeFileSync(snapFile, raw)
    const Database = (await import('better-sqlite3')).default
    const snap = new Database(snapFile, { readonly: true })
    expect(snap.prepare(`SELECT name FROM projects WHERE id = 1`).get().name).toBe('备份验证项目')
    snap.close()
    // 审计 + 历史（含操作人；调度触发的行 memberId 为空显示为系统）
    const h = await authed(app, admin, 'GET', '/api/v1/admin/backup/history')
    expect(h.body.history[0].key).toBe(r.body.key)
    expect(h.body.history[0].ok).toBe(true)
    expect(h.body.history[0].memberName).toBe('管理员')
    db.close()
  })
})

describe('S34 备份执行语义（engine 直调）', () => {
  it('S34-4: 云端滚动保留——超出 keepCount 的最旧对象被删、较新保留；备份对象过滤只认本命名规则', async () => {
    const objects = []
    for (let i = 0; i < 32; i++) {
      objects.push(`backups/gb-pmo-${20260901 + Math.floor(i / 10)}-${String(i % 10).padStart(6, '0')}.db.gz`)
    }
    objects.push('backups/not-a-backup.txt', 'backups/gb-pmo-other.db.gz') // 非本规则对象不动
    const s3 = fakeS3({ objects })
    const { db } = setupDb()
    const out = await runBackup(db, { cfg: { ...CFG, keepCount: 30 }, fetchImpl: s3.fetchImpl })
    expect(out.ok).toBe(true)
    expect(out.deleted).toBe(3) // 32 份旧 + 1 份新 = 33，保留最新 30 → 删 3 份最旧
    const deleted = s3.calls.filter((c) => c.method === 'DELETE').map((c) => c.path.slice(1))
    expect(deleted).toEqual([
      'backups/gb-pmo-20260901-000000.db.gz',
      'backups/gb-pmo-20260901-000001.db.gz',
      'backups/gb-pmo-20260901-000002.db.gz',
    ])
    expect(s3.state.objects).toContain('backups/not-a-backup.txt')
    db.close()
  })

  it('S34-4: 未配全跳过（skipped+原因、零网络）；dueTasks 含 backup 且受 enabled 开关控制；心跳驱动执行', async () => {
    const { db } = setupDb()
    const out = await runBackup(db, { fetchImpl: () => { throw new Error('不应发网络请求') } })
    expect(out).toMatchObject({ ok: false, skipped: true })
    expect(out.reason).toMatch(/backup|备份/)

    const cfg = getSetting(db, 'scheduler')
    expect(cfg.backupCron).toBe('30 3 * * *')
    expect(dueTasks(cfg, { backup: 0 }, Date.now())).toContain('backup')
    expect(dueTasks({ ...cfg, backupEnabled: false }, { backup: 0 }, Date.now())).not.toContain('backup')
    db.close()

    // 调度器心跳：配置齐 + 时间越过一个时点 → backup runner 被调（注入 runner，S18-3 同构）
    const ctx = setupDb()
    setSetting(ctx.db, 'backup', CFG, 1)
    const ran = []
    let clock = Date.now()
    const sched = startScheduler(ctx.db, {
      runners: { backup: async () => { ran.push(1) } },
      tickMs: 5,
      now: () => clock,
    })
    await new Promise((r) => setTimeout(r, 15))
    clock += 26 * 3600 * 1000 // 越过每日时点
    await new Promise((r) => setTimeout(r, 30))
    sched.stop()
    expect(ran.length).toBeGreaterThanOrEqual(1)
    ctx.db.close()
  })
})
