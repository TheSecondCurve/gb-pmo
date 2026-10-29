// 手写 fetch 封装：统一凭据、统一错误（ApiError），每个端点一个具名方法
export class ApiError extends Error {
  constructor(public status: number, message: string, public data?: unknown) {
    super(message)
  }
}

// S24 助手回复 meta（engine/brain/chat.js 落库）
export interface ChatMeta {
  result?: string
  llmCalls?: number
  queries?: number
  sql?: string[]
  eventId?: number
  proposalId?: number
  writeKind?: string
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (res.status === 401 && !location.hash.startsWith('#/login')) {
    location.hash = '#/login'
    throw new ApiError(401, '未登录')
  }
  let data: unknown = null
  try { data = await res.json() } catch { /* 空 body */ }
  if (!res.ok) {
    const msg = (data as { message?: string })?.message || `HTTP ${res.status}`
    throw new ApiError(res.status, msg, data)
  }
  return data as T
}

export const api = {
  login: (username: string, password: string) => req<{ member: { id: number; name: string; role: string } }>('POST', '/api/v1/auth/login', { username, password }),
  logout: () => req<{ ok: boolean }>('POST', '/api/v1/auth/logout'),
  me: () => req<{ member: { id: number; name: string; role: string } | null }>('GET', '/api/v1/auth/me'),

  // S30：可传状态集合（组合页取全部三态）；不传=服务端缺省仅进行中（Dashboard 依赖该缺省，勿改默认行为）
  projects: (statuses?: string[]) => req<{ projects: import('./types').ProjectRow[] }>(
    'GET', `/api/v1/projects${statuses?.length ? `?status=${statuses.join(',')}` : ''}`),
  // S30-7（v0.79，K62）：组合页服务端查询——q 模糊/priority/sort/unscheduled·overdue/分页；total+facets 同响应
  projectsQuery: (p: {
    statuses?: string[]; q?: string; priority?: string; sort?: string
    unscheduled?: boolean; overdue?: boolean; page?: number; pageSize?: number
  } = {}) => {
    const s = new URLSearchParams()
    if (p.statuses?.length) s.set('status', p.statuses.join(','))
    if (p.q) s.set('q', p.q)
    if (p.priority && p.priority !== 'all') s.set('priority', p.priority)
    if (p.sort) s.set('sort', p.sort)
    if (p.unscheduled) s.set('unscheduled', '1')
    if (p.overdue) s.set('overdue', '1')
    if (p.page) s.set('page', String(p.page))
    if (p.pageSize) s.set('pageSize', String(p.pageSize))
    return req<{ projects: import('./types').ProjectRow[]; total: number; facets: { byStatus: Record<string, number>; unscheduled: number; overdueTasks: number } }>(
      'GET', `/api/v1/projects?${s}`)
  },
  project: (id: number) => req<import('./types').ProjectDetail>('GET', `/api/v1/projects/${id}`),
  createProject: (p: Record<string, unknown>) => req<import('./types').ProjectDetail>('POST', '/api/v1/projects', p),
  patchProject: (id: number, p: Record<string, unknown>) => req<import('./types').ProjectDetail>('PATCH', `/api/v1/projects/${id}`, p),
  closeProject: (id: number, body: Record<string, unknown>) => req<import('./types').ProjectDetail>('POST', `/api/v1/projects/${id}/close`, body), // S8/S29：summary 必填；响应带 wikiCloseMark（S29-5 知识页标题标记提示，K73）
  closeoutDraft: (id: number) => req<{ summary: string }>('GET', `/api/v1/projects/${id}/closeout-draft`), // S8-2：AI 复盘草稿（预填可改，不关项目）
  cancelProject: (id: number, body: Record<string, unknown>) => req<import('./types').ProjectDetail>('POST', `/api/v1/projects/${id}/cancel`, body), // S8-3/S29：reason 必填
  projectEvents: (id: number, status?: string) => req<{ events: import('./types').EventRow[] }>('GET', `/api/v1/projects/${id}/events${status ? `?status=${status}` : ''}`),
  addProjectEvent: (id: number, body: Record<string, unknown>) => req('POST', `/api/v1/projects/${id}/events`, body),
  projectDigest: (id: number) => req<Record<string, unknown>>('POST', `/api/v1/projects/${id}/digest`, {}),
  personDigest: (id: number) => req<Record<string, unknown>>('POST', `/api/v1/members/${id}/digest`, {}),

  tasks: (q: Record<string, string | number | undefined>) => {
    const s = new URLSearchParams()
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '') s.set(k, String(v))
    return req<{ tasks: import('./types').TaskRow[] }>('GET', `/api/v1/tasks?${s}`)
  },
  unassigned: () => req<{ tasks: import('./types').TaskRow[] }>('GET', '/api/v1/tasks/unassigned'),
  patchTask: (id: number, p: Record<string, unknown>) => req<import('./types').TaskRow>('PATCH', `/api/v1/tasks/${id}`, p),
  createTask: (p: Record<string, unknown>) => req<import('./types').TaskRow>('POST', '/api/v1/tasks', p),
  // S36 任务删除：软删留痕（refs 一并软删，records/历史事件保留）；终态项目 409
  deleteTask: (id: number) => req<{ ok: boolean }>('DELETE', `/api/v1/tasks/${id}`),
  // S37 项目硬删除：物理抹除全部数据（仅管理员，双重确认），与「取消」的业务终态留痕互补
  deleteProject: (id: number) => req<{ ok: boolean }>('DELETE', `/api/v1/projects/${id}`),
  taskRecords: (id: number) => req<{ records: import('./types').TaskRecordRow[] }>('GET', `/api/v1/tasks/${id}/records`),
  addTaskRecord: (id: number, content: string) => req<{ record: import('./types').TaskRecordRow }>('POST', `/api/v1/tasks/${id}/records`, { content }),
  // S23 任务参考资料：SOP/知识库链接，全员可维护；推送（日报/预警/个人梳理）附带
  taskRefs: (id: number) => req<{ refs: import('./types').TaskRefRow[] }>('GET', `/api/v1/tasks/${id}/refs`),
  addTaskRef: (id: number, body: { title: string; url: string; note?: string }) =>
    req<{ ref: import('./types').TaskRefRow }>('POST', `/api/v1/tasks/${id}/refs`, body),
  patchTaskRef: (taskId: number, refId: number, p: Record<string, unknown>) =>
    req<{ ref: import('./types').TaskRefRow }>('PATCH', `/api/v1/tasks/${taskId}/refs/${refId}`, p),
  deleteTaskRef: (taskId: number, refId: number) => req<{ ok: boolean }>('DELETE', `/api/v1/tasks/${taskId}/refs/${refId}`),
  createMilestone: (p: Record<string, unknown>) => req('POST', '/api/v1/milestones', p),
  patchMilestone: (id: number, p: Record<string, unknown>) => req('PATCH', `/api/v1/milestones/${id}`, p),

  confirmEvent: (id: number) => req('POST', `/api/v1/events/${id}/confirm`, {}),
  rejectEvent: (id: number) => req('POST', `/api/v1/events/${id}/reject`, {}),
  // S4-7（v0.46/K25）：待确认建议一键批量处理（聚合返回，单条失败计入 failed 不阻塞其余）
  confirmEventsBatch: (ids: number[]) =>
    req<{ confirmed: number[]; failed: { id: number; message: string }[] }>('POST', '/api/v1/events/confirm-batch', { ids }),
  rejectEventsBatch: (ids: number[]) =>
    req<{ rejected: number[]; failed: { id: number; message: string }[] }>('POST', '/api/v1/events/reject-batch', { ids }),
  pendingEvents: () => req<{ events: import('./types').EventRow[] }>('GET', '/api/v1/events/pending'),

  // S46（v0.51）：通知收件箱（仅本人推送记录）
  pushes: (limit?: number) =>
    req<{ pushes: import('./types').PushRow[] }>('GET', `/api/v1/pushes${limit ? `?limit=${limit}` : ''}`),

  // S66（v0.73）：我的任务工作台（纯读，按会话成员定域）
  myTasks: () => req<import('./types').MyTasksBoard>('GET', '/api/v1/my-tasks'),

  // S69（v0.80 K64 / v0.81 K65）：常态项目执行视图（span=week|biweek|month 三档，缺省取项目默认；
  // anchor=任意日定位所在期，缺省今天；导航锚点服务端下发）与每日打卡
  dailyBoard: (id: number, opts: { anchor?: string; span?: string } = {}) => {
    const s = new URLSearchParams()
    if (opts.anchor) s.set('anchor', opts.anchor)
    if (opts.span) s.set('span', opts.span)
    const qs = s.toString()
    return req<import('./types').DailyBoardData>('GET', `/api/v1/projects/${id}/daily-board${qs ? `?${qs}` : ''}`)
  },
  setDayStatus: (projectId: number, body: { taskId: number; day: string; status: string; note?: string }) =>
    req<import('./types').DailyCell & { eventId: number | null }>('POST', `/api/v1/projects/${projectId}/daily-board`, body),

  // S47（v0.52）：LLM 用量聚合（仅管理员）
  llmUsage: (days = 7) =>
    req<{ days: number; byPurpose: { purpose: string; calls: number; promptTokens: number; completionTokens: number; avgDurationMs: number | null; errors: number }[]; byDay: { day: string; calls: number; tokens: number; errors: number }[] }>(
      'GET', `/api/v1/admin/llm-usage?days=${days}`),

  // S25 通用提议：确认/驳回（与飞书卡片同一口子，权限矩阵在 engine）
  confirmProposal: (id: number) => req('POST', `/api/v1/proposals/${id}/confirm`, {}),
  rejectProposal: (id: number) => req('POST', `/api/v1/proposals/${id}/reject`, {}),

  // S24 Web AI 助手会话（会话仅本人；软删）
  chatSessions: () =>
    req<{ sessions: { id: number; title: string; created_at: number; updated_at: number }[] }>('GET', '/api/v1/chat/sessions'),
  createChatSession: (title?: string) =>
    req<{ id: number; title: string }>('POST', '/api/v1/chat/sessions', title ? { title } : {}),
  renameChatSession: (id: number, title: string) => req('PATCH', `/api/v1/chat/sessions/${id}`, { title }),
  deleteChatSession: (id: number) => req<{ ok: boolean }>('DELETE', `/api/v1/chat/sessions/${id}`),
  chatMessages: (id: number) =>
    req<{ messages: { id: number; role: string; content: string; meta: ChatMeta | null; created_at: number }[] }>('GET', `/api/v1/chat/sessions/${id}/messages`),
  sendChatMessage: (id: number, text: string) =>
    req<{ user: { id: number; role: string; content: string; meta: ChatMeta | null; created_at: number }; assistant: { id: number; role: string; content: string; meta: ChatMeta | null; created_at: number }; session: { id: number; title: string } }>('POST', `/api/v1/chat/sessions/${id}/messages`, { text }),

  members: () => req<{ members: import('./types').Member[] }>('GET', '/api/v1/members'),
  createMember: (p: Record<string, unknown>) => req('POST', '/api/v1/members', p),
  patchMember: (id: number, p: Record<string, unknown>) => req('PATCH', `/api/v1/members/${id}`, p),
  offboardMember: (id: number, handover: Record<string, unknown>) => req('POST', `/api/v1/members/${id}/offboard`, { handover }),

  channels: () => req<{ channels: import('./types').ChannelRow[] }>('GET', '/api/v1/channels'),
  upsertChannel: (p: Record<string, unknown>) => req('POST', '/api/v1/channels', p),
  deleteChannel: (id: number) => req('DELETE', `/api/v1/channels/${id}`),

  // S61（v0.66）：项目知识库绑定
  projectWiki: (id: number) => req<{ wiki: import('./types').WikiBinding | null }>('GET', `/api/v1/projects/${id}/wiki`),
  bindProjectWiki: (id: number, p: Record<string, unknown>) => req<import('./types').WikiBinding>('POST', `/api/v1/projects/${id}/wiki`, p),

  // S63（v0.68）：项目群全量汇总归档（POST 启动异步台账，GET 轮询）
  wikiArchive: (id: number) => req<{ run: import('./types').WikiArchiveRun | null }>('GET', `/api/v1/projects/${id}/wiki-archive`),
  startWikiArchive: (id: number) => req<{ run: import('./types').WikiArchiveRun }>('POST', `/api/v1/projects/${id}/wiki-archive`),

  // S48（v0.53）：未分拣池消化（仅管理员）
  unrouted: () => req<{ messages: { id: number; platform: string; groupKey: string; businessTime: number; speakerLabel: string | null; content: string }[] }>('GET', '/api/v1/admin/unrouted'),
  routeUnrouted: (id: number, projectId: number) =>
    req<{ ok: boolean; projectId: number; projectName: string; events: number; suggestions: number }>('POST', `/api/v1/admin/unrouted/${id}/route`, { projectId }),
  discardUnrouted: (id: number) => req<{ ok: boolean }>('POST', `/api/v1/admin/unrouted/${id}/discard`, {}),

  projectTypes: () => req<{ types: import('./types').ProjectType[] }>('GET', '/api/v1/project-types'),
  createProjectType: (p: Record<string, unknown>) => req<{ type: import('./types').ProjectType }>('POST', '/api/v1/admin/project-types', p),
  patchProjectType: (id: number, p: Record<string, unknown>) => req<{ type: import('./types').ProjectType }>('PATCH', `/api/v1/admin/project-types/${id}`, p),
  // S17-13（v0.31）：删除类型——无引用守卫物理删除，有引用 400（服务端守卫为准）
  deleteProjectType: (id: number) => req<{ ok: boolean }>('DELETE', `/api/v1/admin/project-types/${id}`),
  // S17-9（v0.18）：任务清单 AI 起草——类型编辑器/立项弹窗共用（全员；草稿不落库）
  draftProjectTasks: (body: { name: string; description?: string }) =>
    req<{ tasks: string[] }>('POST', '/api/v1/projects/draft-tasks', body),
  // S1-7：倒排预览（engine 同一公式，不落库）
  previewSchedule: (body: { planStartDate?: string; planEndDate: string; count: number }) =>
    req<{ schedule: { planStartDate: string; planEndDate: string }[] }>('POST', '/api/v1/projects/preview-schedule', body),
  // S39（v0.42）+ S44（v0.45 异步化）+ S64（v0.69 extra）：AI 初始分配——启动（202 返回 draftId，
  // extra=本次追加要求，与类型 init_prompt/项目 init_extra 三层叠加进 LLM）→ 轮询 → 人审应用（单事务+留痕）
  draftInitAssignments: (projectId: number, extra?: string) =>
    req<{ draftId: string; status: 'running' }>('POST', `/api/v1/projects/${projectId}/draft-init-assignments`, { extra: extra || undefined }),
  getDraftInitAssignment: (projectId: number, draftId: string) =>
    req<{ status: 'running' | 'done' | 'error'; elapsedMs?: number; message?: string; assignments?: import('./types').InitAssignmentRow[]; warnings?: string[] }>(
      'GET', `/api/v1/projects/${projectId}/draft-init-assignments/${draftId}`),
  applyInitAssignments: (projectId: number, assignments: import('./types').InitAssignmentRow[]) =>
    req<{ updated: number }>('POST', `/api/v1/projects/${projectId}/init-assignments`, { assignments }),
  adminTokens: () => req<{ tokensByMember: Record<string, { id: number; name: string; tokenPrefix: string; scope: string; expiresAt: number; revokedAt?: number | null }[]> }>('GET', '/api/v1/admin/tokens'),
  revokeAdminToken: (id: number) => req('DELETE', `/api/v1/admin/tokens/${id}`),

  metric: (id: string, groupBy?: string) => req<import('./types').MetricQuery>('GET', `/api/v1/metrics/${id}/query${groupBy ? `?groupBy=${groupBy}` : ''}`),
  metricCatalog: () => req<{ metrics: import('./types').MetricCard[] }>('GET', '/api/v1/metrics'),

  adminTodo: () => req<{ projects: { id: number; name: string; leadName: string }[] }>('GET', '/api/v1/admin/todo'),
  settings: () => req<Record<string, unknown>>('GET', '/api/v1/admin/settings'),
  putSetting: (key: string, value: unknown) => req('PUT', `/api/v1/admin/settings/${key}`, value),
  runExtraction: (body: { channelId?: number; projectId?: number } = {}) =>
    req<{ channels: { channelId: number; platform: string; pulled?: number; events?: number; suggestions?: number; unrouted?: number; error?: string }[] }>('POST', '/api/v1/admin/extraction/run', body),
  testLlm: (body: object) => req<{ ok: boolean; reason?: string; sample?: string }>('POST', '/api/v1/admin/test-llm', body),
  testIm: (platform: string) => req<{ ok: boolean; reason?: string }>('POST', `/api/v1/admin/test-im/${platform}`, {}),
  // S26 诊断台：诊断 shell（开关默认关）/ 飞书长连接三段自检（仅管理员）
  debugShell: (command: string) =>
    req<{ stdout: string; stderr: string; code: number; timedOut: boolean; truncated: boolean; durationMs: number }>('POST', '/api/v1/admin/debug/shell', { command }),
  feishuSelfcheck: () =>
    req<{ ok: boolean; stages: { stage: string; ok: boolean; reason?: string; note?: string }[] }>('POST', '/api/v1/admin/debug/feishu-selfcheck', {}),
  // S22 飞书项目日历：初始化（创建组织级日历）/ 立即同步（对账式）
  calendarInit: () => req<{ calendarId: string; ok?: boolean; reason?: string }>('POST', '/api/v1/admin/calendar/init', {}),
  calendarSync: () => req<{ calendarId: string; created: number; updated: number; skipped: number; errors: { projectId: number; name: string; error: string }[] } | { skipped: boolean; reason: string }>('POST', '/api/v1/admin/calendar/sync', {}),
  // S34 数据库异地备份：测试连通性（body 可带未存表单值）/ 立即备份 / 最近历史（仅管理员）
  testBackup: (body: object) => req<{ ok: boolean; reason?: string; durationMs?: number }>('POST', '/api/v1/admin/backup/test', body),
  runBackup: () => req<{ ok: boolean; skipped?: boolean; reason?: string; key?: string; bytes?: number; durationMs?: number; deleted?: number }>('POST', '/api/v1/admin/backup/run', {}),
  backupHistory: () => req<{ history: { at: number; memberName: string; ok?: boolean; key?: string; bytes?: number; durationMs?: number; deleted?: number; error?: string; reason?: string }[] }>('GET', '/api/v1/admin/backup/history'),
  // S67-5（v0.77）定时任务手动触发：与调度器同一执行体立即跑一次（仅管理员）
  schedulerRun: (task: string) => req<{ ok: boolean; task: string; result?: unknown; error?: string }>('POST', '/api/v1/admin/scheduler/run', { task }),
  // S67-6（v0.77）运行台账：cron 与手动触发统一记录，最近 N 条新→旧（仅管理员）
  schedulerRuns: (limit = 50) => req<{ runs: { id: number; task: string; origin: string; startedAt: number; durationMs: number; ok: number; summary?: string | null; memberName?: string | null }[] }>('GET', `/api/v1/admin/scheduler/runs?limit=${limit}`),
  // S34-5（v0.77）远端备份对象清单：桶内命名规则对象实时列表（仅管理员；点开才拉）
  backupRemote: () => req<{ ok: boolean; skipped?: boolean; reason?: string; keepCount?: number; count?: number; totalBytes?: number; objects?: { key: string; lastModifiedMs: number | null; bytes: number }[] }>('GET', '/api/v1/admin/backup/remote'),
  tokens: () => req<{ tokens: { id: number; name: string; tokenPrefix: string; scope: string; createdAt: number; expiresAt: number; revokedAt?: number | null }[] }>('GET', '/api/v1/auth/tokens'),
  issueToken: (scope: string, name: string) => req<{ token: string; id: number; scope: string; expiresAt: number }>('POST', '/api/v1/auth/tokens', { scope, name }),
  revokeToken: (id: number) => req('DELETE', `/api/v1/auth/tokens/${id}`),
}
