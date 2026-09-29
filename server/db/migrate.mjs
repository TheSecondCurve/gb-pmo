#!/usr/bin/env node
// 独立迁移入口：node server/db/migrate.mjs [db路径]
import { openDb, migrate } from './index.mjs'

const file = process.argv[2] || process.env.GB_PMO_DB || 'data/gb-pmo.db'
const db = openDb(file)
const n = migrate(db)
console.log(`migrations applied: ${n} (${file})`)
db.close()
