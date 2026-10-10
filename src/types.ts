// 与后端 JSON 契约对齐（camelCase，AGENTS.md §4）
// S41/K23（v0.44）：色彩语义唯一来源——Tone 与 *_TONE 表集中在此，组件查表不散落色值。
export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'muted'
export interface Member {
  id: number; name: string; username: string; feishuId?: string | null; wecomId?: string | null
  team?: string | null; isKeyPerson: boolean; maxParallelProjects: number; role: 'admin' | 'member'
  status: 'active' | 'offboarded'
}
export interface TypeTaskRef { title: string; url: string; note?: string | null }
export interface ProjectType {
  id: number; code: string; name: string; description?: string | null
  initPrompt?: string | null // S39（v0.42）：初始化提示词——该类项目的任务分配/倒排日期自然语言规则，AI 初始分配读取
  tasks: { title: string; refs?: TypeTaskRef[] }[] // v0.18 任务清单内嵌于类型（立项时预填，可覆盖）；v0.33 每任务可挂参考链接（S33，立项时随标题拷贝）
  status: 'active' | 'disabled'; projectCount: number; openProjectCount: number
}
// S39（v0.42）：AI 初始分配草案行/应用行 = 完整目标状态（责任人/计划起止三字段全量覆盖）
export interface InitAssignmentRow {
  taskId: number; title?: string
  responsibleMemberId: number | null; planStartDate: string | null; planEndDate: string | null
}
export interface ProjectRow {
  id: number; name: string; templateCode: string; projectTypeId?: number | null; typeName?: string | null
  status: string; priority: 'high' | 'medium' | 'low'
  leadMemberId: number; leadName: string; clientName?: string | null
  planStartDate?: string | null; planEndDate?: string | null
  daysToDelivery?: number | null // S21：剩余/超期天数（未来为正、已过为负；结项/取消或未填为 null）
  overdueTasks: number; silentDays: number | null; lastEventAt?: number | null; updatedAt: number
  tasksTotal: number; tasksDone: number // S43（v0.44）：任务进度行属性（排除软删；非指标口径，K23）
}
export interface TaskRow {
  id: number; projectId: number; title: string; responsibleMemberId: number | null; responsibleName?: string | null
  status: string; planStartDate?: string | null; planEndDate?: string | null
  isOverdue: boolean
  kind?: string // S57：任务分类 work=工作 / reminder=纯提醒（到期推送后自动完成）
  remindedAt?: number | null // S57：提醒已送达时刻（幂等锚点；改期/重开重置）
  refCount?: number // S23：未删除参考资料条数（项目详情任务行）
}
export interface TaskRefRow {
  id: number; taskId: number; title: string; url: string; note?: string | null
  createdBy?: number | null; createdByName?: string | null; createdAt: number
}
export interface TaskRecordRow { id: number; taskId: number; memberId: number | null; memberName?: string | null; content: string; createdAt: number }
// S46（v0.51，K29）：推送记录（通知收件箱）；status: sent=已送达 / failed=投递失败 / skipped=未投递（error 记原因）
export interface PushRow {
  id: number; pushType: string; title: string; body: string; status: 'sent' | 'failed' | 'skipped'
  error?: string | null; messageId?: string | null; channelPlatform?: string | null
  relatedProjectId?: number | null; createdAt: number
}
export interface MilestoneRow { id: number; projectId: number; name: string; planDate?: string | null; actualDate?: string | null; status: string }
export interface EventRow {
  id: number; projectId: number; businessTime: number; createdAt: number; nature: 'record' | 'suggestion'
  eventType: string; summary: string; speakerLabel?: string | null; status: string
  targetTaskId?: number | null; targetField?: string | null; targetValue?: string | null
  generatedBy: string; sourcePlatform: string; confidence?: number | null
}
export interface ChannelRow {
  id: number; platform: 'feishu' | 'wecom'; groupKey: string; name?: string | null
  channelType: 'dedicated' | 'general'; projectId?: number | null; projectName?: string | null
}
export interface ProjectDetail extends ProjectRow {
  tasks: TaskRow[]
  milestones: MilestoneRow[]
  channels: ChannelRow[]
  closeoutSummary?: string | null
}
export interface MetricQuery { metric: { id: string; name: string; definition: string }; columns: string[]; rows: Record<string, unknown>[] }
export interface MetricCard { id: string; name: string; domain: string; definition: string; dims: string[]; freq: string }

export const PRIORITY_LABEL: Record<string, string> = { high: '高', medium: '中', low: '低' }
export const ROLE_LABEL: Record<string, string> = { admin: '系统管理员', member: '成员' }
export const PROJECT_STATUS_LABEL: Record<string, string> = { active: '进行中', closed: '已结项', cancelled: '已取消' } // S29 三态
export const TASK_STATUS_LABEL: Record<string, string> = { todo: '未开始', doing: '进行中', done: '完成' } // v0.6 固定三档
// S41/S42（v0.44，K23）：状态→色彩语义唯一来源；逾期红不进表——由 isOverdue 在渲染层优先覆盖
export const TASK_STATUS_TONE: Record<string, Tone> = { todo: 'muted', doing: 'info', done: 'ok' }
export const MILESTONE_STATUS_LABEL: Record<string, string> = { planned: '计划中', met: '已达成', missed: '已延误', cancelled: '已取消' }
export const MILESTONE_STATUS_TONE: Record<string, Tone> = { planned: 'muted', met: 'ok', missed: 'bad', cancelled: 'muted' }
export const EVENT_TYPE_LABEL: Record<string, string> = {
  progress: '进展', risk: '风险', decision: '决策', blocker: '阻塞', finance: '财务记录',
  schedule_change: '排期变更', status_change: '状态变更', suggestion: '建议', owner_change: '责任人变更', priority_change: '优先级变更',
}
// S4-8（v0.47）：讨论面分栏的固定栏类型——其余类型（含未识别类型）一律落「其他」栏
export const EVENT_PINNED_COLS: { key: string; title: string; types: string[] }[] = [
  { key: 'progress', title: '进展', types: ['progress'] },
  { key: 'risk', title: '风险 · 阻塞', types: ['risk', 'blocker'] },
  { key: 'finance', title: '财务记录', types: ['finance'] },
]
export const EVENT_STATUS_LABEL: Record<string, string> = { pending: '待确认', effective: '已生效', rejected: '已驳回', expired: '已超时' }
