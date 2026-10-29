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
  tasks: { title: string; note?: string | null; refs?: TypeTaskRef[] }[] // v0.18 任务清单内嵌于类型（立项时预填，可覆盖）；v0.33 每任务可挂参考链接（S33）；v0.64 每任务可配默认备注（S58，立项随任务拷贝）
  status: 'active' | 'disabled'; projectCount: number; openProjectCount: number
}
// S39（v0.42）：AI 初始分配草案行/应用行 = 完整目标状态（责任人/计划起止三字段全量覆盖）
export interface InitAssignmentRow {
  taskId: number; title?: string
  responsibleMemberId: number | null; planStartDate: string | null; planEndDate: string | null
}
export interface ProjectRow {
  id: number; name: string; templateCode: string; projectTypeId?: number | null; typeName?: string | null
  kind?: 'delivery' | 'routine' // S69：项目类别（交付/常态，立项选定后不可变更）
  boardSpan?: 'week' | 'biweek' | 'month' // S69-8（K65）：常态项目执行视图默认窗口（切换即持久化）
  status: string; priority: 'high' | 'medium' | 'low'
  leadMemberId: number; leadName: string; clientName?: string | null
  planStartDate?: string | null; planEndDate?: string | null
  initExtra?: string | null // S64（v0.69）：项目级初始分配补充要求（叠加类型 init_prompt，AI 初始分配三层之一）
  daysToDelivery?: number | null // S21：剩余/超期天数（未来为正、已过为负；结项/取消或未填为 null）
  overdueTasks: number; silentDays: number | null; lastEventAt?: number | null; updatedAt: number
  createdAt: number // 立项时刻（epoch 毫秒；queryProjects SELECT p.* 直出，组合页表格「创建日期」列消费）
  tasksTotal: number; tasksDone: number // S43（v0.44）：项目进度行属性（排除软删；非指标口径，K23）
}
export interface TaskRow {
  id: number; projectId: number; title: string; responsibleMemberId: number | null; responsibleName?: string | null
  status: string; planStartDate?: string | null; planEndDate?: string | null
  note?: string | null // S58：任务备注（≤200 字；模板默认值立项拷贝，实例独立改；提醒/预警推送自动携带）
  isOverdue: boolean
  kind?: string // S57：任务分类 work=工作 / reminder=纯提醒（到期一次性推送后自动完成）/ routine=常态打卡（S69，无状态/排期语义）
  cadence?: Cadence | null // S75：周期四档（唯一真相源；仅 routine 有值）
  cadenceLabel?: string | null // S75：周期中文标签（每天/每周一、三、五/每两周周一/每月1、15号）
  weekdays?: number[] | null // S69 旧出参，S75 起为 cadence 派生值（daily→[1..7]；weekly/biweekly→星期集；monthly→null）
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
/** S61（v0.66）：项目 ↔ 飞书知识库页面绑定。 */
export interface WikiBinding {
  id: number; projectId: number; spaceId: string; nodeToken: string; objToken: string
  title?: string | null; createdBy?: number | null; createdAt: number; updatedAt: number
}
/** S63（v0.68）：项目群全量汇总归档台账（wiki_archive_runs）。 */
export interface WikiArchiveRun {
  id: number; projectId: number; status: 'running' | 'done' | 'failed'
  stage?: 'fetch' | 'summarize' | 'images' | 'files' | 'write' | 'done' | null
  messageCount?: number | null; chunkCount?: number | null; quotesCount?: number | null
  imageCount?: number | null; fileCount?: number | null; skippedFiles?: string | null
  truncated?: number; firstBlockId?: string | null; pageUrl?: string | null; error?: string | null
  createdBy?: number | null; createdAt: number; finishedAt?: number | null
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

// S66（v0.73，K52）：我的任务工作台（GET /api/v1/my-tasks，纯读，按会话成员定域）
export interface MyTaskRow {
  id: number; title: string; status: string; kind: string; note?: string | null
  planStartDate: string | null; planEndDate: string | null
  projectId: number; projectName: string
  isReminder: boolean; overdueDays: number
}
export interface MyTasksBoard {
  today: string
  stats: { total: number; overdue: number; dueThisWeek: number; pending: number }
  projects: Array<{ projectId: number; projectName: string; tasks: MyTaskRow[] }>
}

// S69（v0.80 K64 / v0.81 K65）：常态项目执行视图（GET /api/v1/projects/:id/daily-board?span=&anchor=）
// 窗口三档（周/双周/月），窗口数学唯一在引擎——前端导航只消费 prevAnchor/nextAnchor，零日期推算。
export interface DailyCell {
  day: string // YYYY-MM-DD（北京日）
  applicable: boolean // 该任务在本日是否适用（适用星期勾选）
  status: 'pending' | 'done' | 'skip' // pending=未做（无记录行）
  note: string | null
  operatorMemberId: number | null; operatorName: string | null
  source: string | null // web | bot
  updatedAt: number | null
}
export interface DailyBoardTask {
  taskId: number; title: string; note: string | null
  cadence: Cadence; cadenceLabel: string // S75：周期四档（适用判定在引擎，前端只消费）
  weekdays: number[] | null; weekdaysLabel: string // 派生出参（daily→[1..7]；monthly→null）；label 即周期标签
  responsibleMemberId: number | null; responsibleName: string | null
  cells: DailyCell[]; periodApplicable: number; periodDone: number // 本期口径
}
export interface DailyBoardData {
  projectId: number
  span: 'week' | 'biweek' | 'month'
  start: string; end: string; days: string[]
  prevAnchor: string; nextAnchor: string // 相邻期锚点（引擎下发，导航用）
  tasks: DailyBoardTask[]
  summary: { tasks: number; applicableCells: number; done: number; skip: number; pending: number; perDay: Array<{ day: string; done: number; skip: number }> }
}

// S75（v0.87，K72）：常态任务周期四档（tasks.cadence）。weekly/biweekly 的 weekdays 为 1~7 升序组合；
// biweekly.parity=0|1 是 K65 双周纪元锚（2024-01-01 起每 14 天一期）的期别；monthly.monthDays 为 1~31 组合
//（当月无该日不适用，cron 语义）。适用判定唯一在引擎（isApplicableDay），前端不重复实现。
export type Cadence =
  | { type: 'daily' }
  | { type: 'weekly'; weekdays: number[] }
  | { type: 'biweekly'; weekdays: number[]; parity: 0 | 1 }
  | { type: 'monthly'; monthDays: number[] }
export const CADENCE_TYPE_LABEL: Record<Cadence['type'], string> = { daily: '每天', weekly: '每周', biweekly: '每两周', monthly: '每月' }
/** 周期 → 按钮短标签（触发器/选择器显示；与引擎 cadenceLabel 同文案口径）。 */
export function cadenceShortLabel(c: Cadence | null | undefined): string {
  const cad = c?.type ? c : { type: 'daily' } as Cadence
  if (cad.type === 'daily') return '每天'
  if (cad.type === 'weekly') return `每周${cad.weekdays.map((d) => '一二三四五六日'[d - 1]).join('、')}`
  if (cad.type === 'biweekly') return `每两周周${cad.weekdays.map((d) => '一二三四五六日'[d - 1]).join('、周')}`
  return `每月${cad.monthDays.join('、')}号`
}

export type BoardSpan = 'week' | 'biweek' | 'month'
export const PROJECT_KIND_LABEL: Record<string, string> = { delivery: '交付项目', routine: '常态项目' }
export const BOARD_SPAN_LABEL: Record<string, string> = { week: '周', biweek: '双周', month: '月' }
export const DAY_STATUS_LABEL: Record<string, string> = { pending: '未做', done: '完成', skip: '跳过' }
export const DAY_STATUS_TONE: Record<string, Tone> = { pending: 'muted', done: 'ok', skip: 'warn' }
export const WEEKDAY_SHORT: string[] = ['', '一', '二', '三', '四', '五', '六', '日']
