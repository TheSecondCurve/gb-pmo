import { describe, it, expect } from 'vitest'
import { setupDb } from './helpers.mjs'
import { openDb, migrate } from '../db/index.mjs'

// engineering-standards §4：迁移幂等（跑两次不出错）+ fresh 库全量迁移后可启动

describe('迁移', () => {
  it('幂等：重复执行不报错、不重复种子', () => {
    const { db, dir } = setupDb()
    const again = migrate(db)
    expect(again).toBe(0)
    // v0.18：模板对象并入项目类型——模板表已裁撤，任务清单挂在类型下
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN ('project_templates','template_tasks','template_stages','stages','dependencies')`).all()).toEqual([])
    const types = db.prepare('SELECT COUNT(*) AS n FROM project_types').get().n
    expect(types).toBe(3)
    const tasks = db.prepare('SELECT COUNT(*) AS n FROM project_type_tasks').get().n
    expect(tasks).toBe(10) // 软件交付 6 + 咨询 4（回填自原默认模板；custom 本就为空）
    // default_template_id 列已随迁移删除
    expect(db.prepare(`SELECT COUNT(*) AS n FROM pragma_table_info('project_types') WHERE name = 'default_template_id'`).get().n).toBe(0)
    migrate(db)
    expect(db.prepare('SELECT COUNT(*) AS n FROM project_type_tasks').get().n).toBe(tasks)
    // v0.6：阶段与依赖已裁剪，表不存在；任务状态无遗留 blocked/cancelled
    expect(db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE status IN ('blocked','cancelled')`).get().n).toBe(0)
    db.close()
  })

  it('备份恢复冒烟：从 .backup 重建库 → 数据完整 → 应用可用（构建即启动路径）', async () => {
    const { db, dir } = setupDb()
    db.prepare(
      `INSERT INTO members (name, username, password_hash, role, status, created_at, updated_at)
       VALUES ('恢复者', 'restorer', NULL, 'member', 'active', ?, ?)`
    ).run(Date.now(), Date.now())
    db.prepare(
      `INSERT INTO projects (name, template_code, status, priority, lead_member_id, created_at, updated_at)
       VALUES ('恢复验证', 'software_delivery', 'active', 'high', 1, ?, ?)`
    ).run(Date.now(), Date.now())
    db.prepare(`INSERT INTO project_events (project_id, business_time, created_at, nature, event_type, summary, status, generated_by, pushed_to)
       VALUES (1, ?, ?, 'record', 'progress', '备份前写入的事件', 'effective', 'system', '[]')`).run(Date.now(), Date.now())

    // 备份的承诺是"可恢复"——用在线 backup API（等价 sqlite3 .backup，禁 cp 热库）
    const backupFile = `${dir}/backup.db`
    await db.backup(backupFile)

    const restored = openDb(backupFile)
    migrate(restored) // 恢复后迁移向前兼容
    expect(restored.prepare(`SELECT name FROM projects WHERE id = 1`).get().name).toBe('恢复验证')
    expect(restored.prepare(`SELECT summary FROM project_events LIMIT 1`).get().summary).toContain('备份前写入')

    const { buildApp } = await import('../routes/app.js')
    const app = buildApp(restored, { baseUrl: 'http://t', cookieSecret: 'restore-smoke-cookie-secret-32bytes!' })
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/api/v1/health' })
    expect(res.statusCode).toBe(200)
    db.close()
    restored.close()
  })
})
