// S25（v0.17）通用提议：项目级/配置级操作的「提议→确认→生效」唯一口子。
// 发起放开（成员均可让 AI 起草），确认按矩阵收紧；生效分发到既有 engine（校验/审计/事件同构）。
// LLM 信任边界不变：只产提议，不选生效路径（AGENTS.md §4 / PRD §2）。
// v0.18：模板对象裁撤——kind 收敛为四类；create_project 可带 tasks + autoSchedule（倒排算术在 engine）。

import * as projects from './projects.js'
import * as projectTypes from './projectTypes.js'

const notFound = () => Object.assign(new Error('提议不存在'), { statusCode: 404 })
const conflict = (msg) => Object.assign(new Error(msg), { statusCode: 409 })
const forbidden = (msg) => Object.assign(new Error(msg), { statusCode: 403 })

const normTasks = (tasks) => (Array.isArray(tasks) ? tasks : [])
  .map((t) => (typeof t === 'string' ? { title: t } : t))
  .filter((t) => t && t.title)

// —— 提议目录：确认权限矩阵 + 生效分发（apply 强校验全部交给既有 engine） ——

export const PROPOSAL_KINDS = {
  update_project_status: {
    label: '项目状态变更',
    async canConfirm(db, member, payload) {
      const p = db.prepare('SELECT lead_member_id FROM projects WHERE id = ?').get(Number(payload.projectId))
      if (member.role !== 'admin' && p?.lead_member_id !== member.id) {
        return forbidden('仅项目牵头人或系统管理员可确认项目状态提议')
      }
      return true
    },
    apply(db, payload, by) {
      const patch = { status: String(payload.status) }
      if (payload.planEndDate !== undefined) patch.planEndDate = payload.planEndDate
      return projects.updateProject(db, Number(payload.projectId), patch, by)
    },
  },
  close_project: {
    label: '项目结项',
    canConfirm: null, // 与项目状态同一矩阵，对象字面量后统一赋值（牵头人/管理员）
    apply(db, payload, by) {
      return projects.closeProject(db, Number(payload.projectId), { summary: payload.summary }, by)
    },
  },
  create_project: {
    label: '新建项目',
    async canConfirm(db, member, payload) {
      if (member.role !== 'admin' && Number(payload.leadMemberId) !== member.id) {
        return forbidden('仅系统管理员或拟任牵头人可确认立项提议')
      }
      return true
    },
    apply(db, payload, by) {
      return projects.createProject(db, {
        name: payload.name, typeCode: payload.typeCode, templateCode: payload.templateCode,
        leadMemberId: Number(payload.leadMemberId), priority: payload.priority, clientName: payload.clientName,
        planStartDate: payload.planStartDate, planEndDate: payload.planEndDate,
        ...(payload.tasks !== undefined ? { tasks: normTasks(payload.tasks) } : {}),
        ...(payload.autoSchedule !== undefined ? { autoSchedule: payload.autoSchedule } : {}),
      }, by)
    },
  },
  create_project_type: {
    label: '新建项目类型',
    async canConfirm(db, member) {
      if (member.role !== 'admin') return forbidden('项目类型为配置对象，仅系统管理员可确认')
      return true
    },
    apply(db, payload, by) {
      return projectTypes.createProjectType(db, {
        code: payload.code, name: payload.name, description: payload.description,
        tasks: normTasks(payload.tasks),
      }, by)
    },
  },
}
// close_project 与项目状态同一矩阵（牵头人/管理员）
PROPOSAL_KINDS.close_project.canConfirm = PROPOSAL_KINDS.update_project_status.canConfirm

// —— 口子 ——

export function createProposal(db, { kind, payload = {}, summary, proposedBy }) {
  if (!PROPOSAL_KINDS[kind]) {
    throw Object.assign(new Error(`未知提议类型: ${kind}（可用 ${Object.keys(PROPOSAL_KINDS).join(' / ')}）`), { statusCode: 400 })
  }
  const text = String(summary || '').trim()
  if (!text) throw Object.assign(new Error('summary 必填（一句中文摘要）'), { statusCode: 400 })
  const info = db
    .prepare('INSERT INTO proposals (kind, payload, summary, status, proposed_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(kind, JSON.stringify(payload), text.slice(0, 200), 'pending', proposedBy ?? null, Date.now())
  return getProposal(db, Number(info.lastInsertRowid))
}

export function getProposal(db, id) {
  const row = db.prepare('SELECT * FROM proposals WHERE id = ?').get(Number(id))
  if (!row) throw notFound()
  return { ...row, payload: JSON.parse(row.payload) }
}

export async function confirmProposal(db, id, by) {
  const p = getProposal(db, id)
  if (p.status !== 'pending') throw conflict(`提议状态为 ${p.status}，仅待确认提议可确认`)
  const member = db.prepare('SELECT id, role, status FROM members WHERE id = ?').get(by)
  if (!member || member.status !== 'active') throw forbidden('确认人须为在职成员')
  const spec = PROPOSAL_KINDS[p.kind]
  const allowed = await spec.canConfirm(db, member, p.payload)
  if (allowed !== true) throw allowed
  const result = await spec.apply(db, p.payload, by)
  db.prepare('UPDATE proposals SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?')
    .run('effective', by, Date.now(), p.id)
  return { proposal: getProposal(db, id), result }
}

export async function rejectProposal(db, id, by) {
  const p = getProposal(db, id)
  if (p.status !== 'pending') throw conflict(`提议状态为 ${p.status}，仅待确认提议可驳回`)
  const member = db.prepare('SELECT id, role, status FROM members WHERE id = ?').get(by)
  if (!member || member.status !== 'active') throw forbidden('操作人须为在职成员')
  // 驳回门槛与确认同矩阵，另允许提议人自行撤回
  const spec = PROPOSAL_KINDS[p.kind]
  const allowed = member.role === 'admin' || p.proposed_by === by || (await spec.canConfirm(db, member, p.payload)) === true
  if (!allowed) throw forbidden('仅确认矩阵内成员或提议人可驳回')
  db.prepare('UPDATE proposals SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?')
    .run('rejected', by, Date.now(), p.id)
  return getProposal(db, id)
}
