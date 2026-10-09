// 大脑·AI 初始分配草案（S39，v0.42 / design.md K21；S44，v0.45 / K24 异步化）：读类型初始化提示词
//（project_types.init_prompt）+ 项目未删未完成任务清单 + 在职成员名册，产每条任务的「责任人 + 计划起止」批量分配草案。
// 信任边界：草案不落库——web 弹窗人审后应用；Agent apply_init_assignments 可直写（限定例外，
// 仅限该 action，逐行校验+审计）。LLM 未配置给明确指引，不降级瞎生成（templates.js 同构）。
// v0.45（S44）：请求模型异步化——启动同步校验后 202 返回 draftId（LLM 进程内后台执行），轮询取
// running/done/error（错误以 200 载荷返回）。原因：部署边缘对源站响应 ~120s 即 524，GLM 大 JSON
// 稳态要约 2 分钟，同步等待模型与边缘上限架构性不兼容。作业注册表=进程内 Map（瞬态不落库，重启即作废）。

import { getLlm, parseJsonLoose } from './llm.js'
import { camelizeRow, camelizeRows } from '../db/index.mjs'
import { today } from '../db/time.js'
import { isCalendarDay } from '../engine/tasks.js'

/** 同步前置校验（启动与执行共用）：项目存在（404）且非终态（409 任务面只读）。 */
function preflight(db, projectId) {
  const project = camelizeRow(
    db.prepare(
      `SELECT p.*, pt.name AS type_name, pt.init_prompt AS type_init_prompt
       FROM projects p LEFT JOIN project_types pt ON pt.id = p.project_type_id WHERE p.id = ?`
    ).get(Number(projectId))
  )
  if (!project) throw Object.assign(new Error('项目不存在'), { statusCode: 404 })
  if (project.status !== 'active') {
    throw Object.assign(new Error('项目已结项/取消，任务面只读'), { statusCode: 409 })
  }
  return project
}

function assertLlm(db, llmOverride) {
  const llm = getLlm(db, llmOverride)
  if (!llm) {
    throw Object.assign(new Error('LLM 未配置：请先在配置台「外部依赖 → LLM」配置任一类别（DeepSeek / GLM 国内 Coding Plan，可先「测试连接」）后再用 AI 初始分配'), { statusCode: 503 })
  }
  return llm
}

/**
 * 产初始分配草案（不落库，S44 起由作业注册表后台调用）。返回 { assignments: [{taskId, title, responsibleMemberId, planStartDate, planEndDate}], warnings: [] }
 * —— assignments 覆盖项目全部未删未完成任务（LLM 遗漏/非法行 → 补「保持现状」行，草案=完整目标状态）。
 */
export async function draftInitAssignments(db, projectId, { llm: llmOverride } = {}) {
  const project = preflight(db, projectId)
  const llm = assertLlm(db, llmOverride)

  const tasks = camelizeRows(
    db.prepare(
      `SELECT t.id, t.title, t.responsible_member_id, t.plan_start_date, t.plan_end_date, m.name AS responsible_name
       FROM tasks t LEFT JOIN members m ON m.id = t.responsible_member_id
       WHERE t.project_id = ? AND t.deleted_at IS NULL AND t.status != 'done' ORDER BY t.id`
    ).all(project.id)
  )
  if (!tasks.length) return { assignments: [], warnings: ['项目没有未完成（todo/doing）任务'] }

  const members = camelizeRows(
    db.prepare(`SELECT id, name, team FROM members WHERE status = 'active' ORDER BY id`).all()
  )
  const out = await llm.complete(
    [
      {
        role: 'system',
        content: `你是企业项目大脑的初始分配器。根据项目信息、未完成任务清单、在职成员名册与「初始化提示词」（管理员配置的本类项目任务分配与倒排日期规则），为每条任务给出责任人与计划起止，输出 JSON {"assignments":[{"taskId":1,"responsibleMemberId":2|null,"planStartDate":"YYYY-MM-DD"|null,"planEndDate":"YYYY-MM-DD"|null}]}。
规则：每条任务恰好一行，taskId 只能取任务清单里的 id；responsibleMemberId 只能取成员名册里的 id，没有把握就给 null（未指派）；日期一律真实日历日 YYYY-MM-DD，截止不早于开始，尽量落在项目计划周期内、不早于今天；任务现值不需要调整时照抄现值；只输出 JSON。`,
      },
      {
        role: 'user',
        content: `项目：${project.name}（类型 ${project.typeName || '未知'}；计划 ${project.planStartDate || '未定'} ~ ${project.planEndDate || '未定'}；今天 ${today()}）
初始化提示词：${project.typeInitPrompt?.trim() || '（未配置——按任务标题语义与成员名册自行匹配责任人，并在项目周期内按任务顺序铺开排期）'}
在职成员名册：${members.map((m) => `#${m.id} ${m.name}${m.team ? `（${m.team}）` : ''}`).join('、') || '（空）'}
未完成任务清单：
${tasks.map((t) => `#${t.id} ${t.title}（现责任人 ${t.responsibleName || '未指派'}，现计划 ${t.planStartDate || '?'} ~ ${t.planEndDate || '?'}）`).join('\n')}`,
      },
    ],
    { json: true }
  )

  // 白名单后校验（extract.js 模式）：taskId 须属本项目未完成任务、成员须在职、日期须真实日历日且止≥起；
  // 非法行丢弃进 warnings，LLM 遗漏/被弃任务在最后统一补「保持现状」行
  const parsed = parseJsonLoose(out)
  const rows = Array.isArray(parsed?.assignments) ? parsed.assignments : []
  const warnings = []
  if (!Array.isArray(parsed?.assignments)) warnings.push('LLM 输出缺少 assignments 数组，全部任务保持现状')
  const taskById = new Map(tasks.map((t) => [t.id, t]))
  const memberIds = new Set(members.map((m) => m.id))
  const proposed = new Map()
  for (const raw of rows) {
    const r = typeof raw === 'object' && raw !== null ? raw : {}
    const taskId = Number(r.taskId)
    if (!Number.isInteger(taskId) || !taskById.has(taskId)) {
      warnings.push(`丢弃非本项目任务的行（taskId=${JSON.stringify(r.taskId)}）`)
      continue
    }
    if (proposed.has(taskId)) {
      warnings.push(`任务 #${taskId} 重复行，已取首行`)
      continue
    }
    let owner = null
    if (r.responsibleMemberId != null) {
      const mid = Number(r.responsibleMemberId)
      if (!Number.isInteger(mid) || !memberIds.has(mid)) {
        warnings.push(`任务 #${taskId} 的责任人 id 无效或已离职（${JSON.stringify(r.responsibleMemberId)}），该行保持现状`)
        continue
      }
      owner = mid
    }
    const ps = r.planStartDate == null ? null : String(r.planStartDate)
    const pe = r.planEndDate == null ? null : String(r.planEndDate)
    if ((ps !== null && !isCalendarDay(ps)) || (pe !== null && !isCalendarDay(pe)) || (ps !== null && pe !== null && pe < ps)) {
      warnings.push(`任务 #${taskId} 的日期非法（${ps ?? '∅'} ~ ${pe ?? '∅'}），该行保持现状`)
      continue
    }
    proposed.set(taskId, { taskId, responsibleMemberId: owner, planStartDate: ps, planEndDate: pe })
  }
  const assignments = tasks.map((t) => ({
    title: t.title,
    ...(proposed.get(t.id) ?? {
      taskId: t.id,
      responsibleMemberId: t.responsibleMemberId ?? null,
      planStartDate: t.planStartDate ?? null,
      planEndDate: t.planEndDate ?? null,
    }),
  }))
  return { assignments, warnings }
}

// —— S44（v0.45）：草案作业注册表（进程内 Map，瞬态不落库；10 分钟 TTL + 200 容量，访问时惰性清理）——

const JOB_TTL_MS = 10 * 60 * 1000
const JOB_MAX = 200
const jobs = new Map() // draftId → { projectId, status, createdAt, doneAt?, assignments?, warnings?, error? }
let jobSeq = 0

function pruneJobs() {
  const now = Date.now()
  for (const [id, j] of jobs) if (now - j.createdAt > JOB_TTL_MS) jobs.delete(id)
  while (jobs.size > JOB_MAX) jobs.delete(jobs.keys().next().value)
}

/**
 * 启动草案作业：同步前置校验（404/409/503 与执行同口径），立即返回 {draftId, status:'running'}；
 * LLM 进程内后台执行，结果/错误落注册表。
 */
export function startDraftInitAssignments(db, projectId, { llm: llmOverride } = {}) {
  preflight(db, projectId) // 同步 404/409
  const llm = assertLlm(db, llmOverride) // 同步 503（并把已解析的适配器传入后台，避免二次解析）
  pruneJobs()
  const draftId = `d${Date.now().toString(36)}${(++jobSeq).toString(36)}`
  const job = { projectId: Number(projectId), status: 'running', createdAt: Date.now() }
  jobs.set(draftId, job)
  void draftInitAssignments(db, projectId, { llm })
    .then((out) => {
      job.status = 'done'; job.assignments = out.assignments; job.warnings = out.warnings; job.doneAt = Date.now()
    })
    .catch((e) => {
      job.status = 'error'; job.error = String(e?.message || '草案生成失败'); job.doneAt = Date.now()
    })
  return { draftId, status: 'running' }
}

/** 轮询作业：running（含 elapsedMs）/ done（assignments/warnings）/ error（message）；他项目或不存在/过期 → 404。 */
export function getDraftInitAssignment(projectId, draftId) {
  pruneJobs()
  const job = jobs.get(String(draftId))
  if (!job || job.projectId !== Number(projectId)) {
    throw Object.assign(new Error('草案作业不存在或已过期（10 分钟有效期），请重新发起'), { statusCode: 404 })
  }
  if (job.status === 'running') return { status: 'running', elapsedMs: Date.now() - job.createdAt }
  if (job.status === 'error') return { status: 'error', message: job.error, elapsedMs: job.doneAt - job.createdAt }
  return { status: 'done', assignments: job.assignments, warnings: job.warnings, elapsedMs: job.doneAt - job.createdAt }
}
