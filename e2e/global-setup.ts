import fs from 'node:fs'
import path from 'node:path'

// 每次 e2e 运行重置专用库（GB_PMO_DB=data/e2e.db）：管理员由 bootstrap 重建，旅程从干净盘面起跑。
export default async function globalSetup() {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = path.resolve(`data/e2e.db${suffix}`)
    if (fs.existsSync(f)) fs.rmSync(f)
  }
}
