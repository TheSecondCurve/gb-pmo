// 与后端 JSON 契约对齐（camelCase，AGENTS.md §4）
export interface Member {
  id: number; name: string; username: string; feishuId?: string | null; wecomId?: string | null
  team?: string | null; isKeyPerson: boolean; maxParallelProjects: number; role: 'admin' | 'member'
  status: 'active' | 'offboarded'
}
export interface ProjectType {
  id: number; code: string; name: string; description?: string | null
  defaultTemplateId: number; defaultTemplateName?: string | null; defaultTemplateCode?: string | null
  status: 'active' | 'disabled'; projectCount: number; openProjectCount: number
}
export interface TemplateRow {
  id: number; code: string; name: string; description?: string | null
  stages: string[]; tasks: { stageName: string; title: string }[]
  typeCount: number; projectCount: number
}
export interface ProjectRow {
  id: number; name: string; templateCode: string; projectTypeId?: number | null; typeName?: string | null
  status: string; priority: 'high' | 'medium' | 'low'
  leadMemberId: number; leadName: string; clientName?: string | null
  planStartDate?: string | null; planEndDate?: string | null
  daysToDelivery?: number | null // S21：剩余/超期天数（未来为正、已过为负；结项/取消或未填为 null）
  overdueTasks: number; silentDays: number | null; lastEventAt?: number | null; updatedAt: number
}
export interface TaskRow {
  id: number; projectId: number; title: string; responsibleMemberId: number | null; responsibleName?: string | null
  status: string; planStartDate?: string | null; planEndDate?: string | null
  isOverdue: boolean
  refCount?: number // S23：未删除参考资料条数（项目详情任务行）
}
export interface TaskRefRow {
  id: number; taskId: number; title: string; url: string; note?: string | null
  createdBy?: number | null; createdByName?: string | null; createdAt: number
}
export interface TaskRecordRow { id: number; taskId: number; memberId: number | null; memberName?: string | null; content: string; createdAt: number }
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
export const PROJECT_STATUS_LABEL: Record<string, string> = { planning: '待启动', active: '进行中', paused: '已暂停', closed: '已结项', cancelled: '已取消' }
export const TASK_STATUS_LABEL: Record<string, string> = { todo: '未开始', doing: '进行中', done: '完成' } // v0.6 固定三档
export const EVENT_TYPE_LABEL: Record<string, string> = {
  progress: '进展', risk: '风险', decision: '决策', blocker: '阻塞', schedule_change: '排期变更',
  status_change: '状态变更', suggestion: '建议', owner_change: '责任人变更', priority_change: '优先级变更',
}
export const EVENT_STATUS_LABEL: Record<string, string> = { pending: '待确认', effective: '已生效', rejected: '已驳回', expired: '已超时' }
