#!/usr/bin/env node
// SKILL.md schema 区块生成器 + drift check（engineering-standards §4：不靠人记得跑）。
// 表结构从 migrations 解析（列注释保留），枚举从 engine/enums.js 导入。
// 用法：node scripts/gen-skill-schema.mjs [--check]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ENUMS } from '../server/engine/enums.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const SKILL_FILE = path.join(ROOT, 'skills/gb-pmo/SKILL.md')

function parseTables() {
  const dir = path.join(ROOT, 'server/db/migrations')
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
  const tables = new Map()
  for (const f of files) {
    const sql = fs.readFileSync(path.join(dir, f), 'utf8')
    for (const m of sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n\)/g)) {
      const [, name, body] = m
      const cols = []
      for (let line of body.split('\n')) {
        line = line.trim()
        if (!line || /^(CREATE|PRIMARY|UNIQUE|FOREIGN|CHECK|CONSTRAINT)/i.test(line)) continue
        const colMatch = line.match(/^(\w+)\s+([A-Za-z]+)(.*)$/)
        if (!colMatch) continue
        const comment = (colMatch[3].match(/--\s*(.+)$/)?.[1] || '').trim()
        cols.push({ name: colMatch[1], type: colMatch[2].toUpperCase(), comment })
      }
      if (!tables.has(name)) tables.set(name, [])
      for (const c of cols) if (!tables.get(name).some((x) => x.name === c.name)) tables.get(name).push(c)
    }
    for (const m of sql.matchAll(/ALTER TABLE (\w+) ADD COLUMN (\w+) ([A-Za-z]+)(.*);/g)) {
      const [, tName, cName, type, rest] = m
      const comment = (rest.match(/--\s*(.+)$/)?.[1] || '').trim()
      if (!tables.has(tName)) tables.set(tName, [])
      if (!tables.get(tName).some((x) => x.name === cName)) tables.get(tName).push({ name: cName, type: type.toUpperCase(), comment })
    }
    // 后续迁移中的删表/删列要反映到最终结构（迁移按文件名序叠加解析）
    for (const m of sql.matchAll(/DROP TABLE (?:IF EXISTS )?(\w+)/g)) {
      tables.delete(m[1])
    }
    for (const m of sql.matchAll(/ALTER TABLE (\w+) DROP COLUMN (\w+)/g)) {
      const list = tables.get(m[1])
      if (list) tables.set(m[1], list.filter((c) => c.name !== m[2]))
    }
  }
  return tables
}

function render() {
  const tables = parseTables()
  const lines = ['<!--SCHEMA:BEGIN（本区块由 scripts/gen-skill-schema.mjs 生成，勿手改；drift check 比对）-->']
  lines.push('', '## 数据表（snake_case，与 Agent SQL 端点直连的结构一致）', '')
  for (const [name, cols] of tables) {
    lines.push(`### ${name}`, '', '| 列 | 类型 | 说明 |', '|---|---|---|')
    for (const c of cols) lines.push(`| ${c.name} | ${c.type} | ${c.comment || ''} |`)
    lines.push('')
  }
  lines.push('## 枚举（值 ↔ 中文 label，双向对齐）', '')
  for (const [group, map] of Object.entries(ENUMS)) {
    lines.push(`- **${group}**: ${Object.entries(map).map(([v, l]) => `${v}=${l}`).join('、')}`)
  }
  lines.push('', '<!--SCHEMA:END-->')
  return lines.join('\n')
}

const HEADER = `---
name: gb-pmo
version: 0.1.0
description: 企业项目大脑——项目/任务/事件/成员的查询、维护与大脑功能触发
---

# gb-pmo 企业项目大脑 · Agent Skill

你是团队成员的 Agent，通过本 skill 读写项目大脑。所有数据全员透明（D1）。

## 快速开始

\`\`\`bash
# 1. 安装 skill（更新 = 重跑同一条命令）
curl -fsSL http://<服务器地址>/agent/skill/gb-pmo/install.sh | sh
# 2. 终端授权（密码只走终端，不经 Agent 对话；凭证存 ~/.gb-pmo/credentials.json）
curl -fsSL http://<服务器地址>/agent/login.sh | sh
# 3. 使用（安装目录下的 client.sh）
client.sh sql "SELECT id, name, status, priority FROM projects WHERE status IN ('planning','active','paused')"
client.sh metrics
client.sh metric overdue_tasks '{"groupBy":"project"}'
client.sh action generate_person_digest '{}'
\`\`\`

## 端点与分工（D4：SQL + REST action 双通道）

| 用途 | 端点 | 说明 |
|---|---|---|
| 查询/写入 | \`POST /api/v1/agent/sql\` \`{"sql": "..."}\` | 单语句；读=SELECT/WITH/VALUES；写需 write scope（INSERT/UPDATE/DELETE） |
| 指标 | \`GET /api/v1/agent/metrics\` | 指标目录（定义卡） |
| 指标取数 | \`POST /api/v1/agent/metrics/query\` \`{"metric":"<id>","params":{}}\` | **指标类问题优先走这里**；自算 SQL 与端点不一致时以端点为准 |
| 触发 | \`POST /api/v1/agent/actions\` | 白名单：trigger_extraction / generate_project_digest / generate_person_digest / push_report |

## 工作守则（必须遵守）

1. **指标以 metrics 端点为准**（口径同源 dashboard）；明细与自由查询才用 SQL 端点。
2. **写 SQL 守则**：手动补 \`updated_at\`（epoch 毫秒）与审计需要的字段；软删不硬删（人员改 status='offboarded'，不要 DELETE）；403 不换字段重试；只改自己为责任人/牵头人的对象，跨人变更走建议。
3. **LLM 信任边界**：口述更新一律 \`INSERT INTO project_events (nature='suggestion', status='pending', ...)\` 生成建议，等人在页面/接口确认；绝不直接 \`UPDATE tasks\` 改状态/日期/责任人。
4. 常用查询模式：
   - 「我本周的任务」：\`SELECT t.id, t.title, t.plan_end_date, p.name FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.responsible_member_id=<我> AND t.status IN ('todo','doing')\`
   - 「B 项目卡在哪」：看 project_events 最新 blocker/risk + 逾期未完任务（plan_end_date < date('now') 且 status != 'done'）。
   - 任务状态固定三档：todo/doing/done（v0.6，无 blocked/cancelled）；任务相互独立，无前置依赖。
5. 建议事件的 target 字段组合：task → status/plan_start_date/plan_end_date/responsible_member_id；milestone → target_object='milestone' 且 plan_date。

`

const FOOTER = `
## 里程碑建议示例（S4-3）

\`\`\`sql
INSERT INTO project_events (project_id, business_time, created_at, nature, event_type, summary,
  source_platform, speaker_member_id, speaker_label, status, target_object, target_task_id,
  target_field, target_value, generated_by, pushed_to)
VALUES (<pid>, strftime('%s','now')*1000, strftime('%s','now')*1000, 'suggestion', 'schedule_change',
  '验收推迟到 2026-10-20', 'agent', <我>, '<我>', 'pending', 'milestone', <里程碑id>,
  'plan_date', '2026-10-20', 'agent', '[]');
\`\`\`

用户在 Web 或 \`POST /api/v1/events/<id>/confirm\` 确认后生效。
`

const next = HEADER + '\n' + render() + '\n' + FOOTER

if (process.argv.includes('--check')) {
  const cur = fs.existsSync(SKILL_FILE) ? fs.readFileSync(SKILL_FILE, 'utf8') : ''
  if (cur !== next) {
    console.error('gen-skill-schema: FAIL — SKILL.md 与 migrations/enums 存在漂移，运行 npm run gen:skill 重新生成')
    process.exit(1)
  }
  console.log('gen-skill-schema: OK — SKILL.md 与 migrations/enums 对齐')
} else {
  fs.mkdirSync(path.dirname(SKILL_FILE), { recursive: true })
  fs.writeFileSync(SKILL_FILE, next)
  console.log(`gen-skill-schema: written ${path.relative(ROOT, SKILL_FILE)}`)
}
