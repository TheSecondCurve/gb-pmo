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

  projects: () => req<{ projects: import('./types').ProjectRow[] }>('GET', '/api/v1/projects'),
  project: (id: number) => req<import('./types').ProjectDetail>('GET', `/api/v1/projects/${id}`),
  createProject: (p: Record<string, unknown>) => req<import('./types').ProjectDetail>('POST', '/api/v1/projects', p),
  patchProject: (id: number, p: Record<string, unknown>) => req<import('./types').ProjectDetail>('PATCH', `/api/v1/projects/${id}`, p),
  closeProject: (id: number, body: Record<string, unknown>) => req<import('./types').ProjectDetail>('POST', `/api/v1/projects/${id}/close`, body), // S8/S29：summary 必填（结项规则=全部任务完成）
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
  pendingEvents: () => req<{ events: import('./types').EventRow[] }>('GET', '/api/v1/events/pending'),

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

  projectTypes: () => req<{ types: import('./types').ProjectType[] }>('GET', '/api/v1/project-types'),
  createProjectType: (p: Record<string, unknown>) => req<{ type: import('./types').ProjectType }>('POST', '/api/v1/admin/project-types', p),
  patchProjectType: (id: number, p: Record<string, unknown>) => req<{ type: import('./types').ProjectType }>('PATCH', `/api/v1/admin/project-types/${id}`, p),
  // S17-9（v0.18）：任务清单 AI 起草——类型编辑器/立项弹窗共用（全员；草稿不落库）
  draftProjectTasks: (body: { name: string; description?: string }) =>
    req<{ tasks: string[] }>('POST', '/api/v1/projects/draft-tasks', body),
  // S1-7：倒排预览（engine 同一公式，不落库）
  previewSchedule: (body: { planStartDate?: string; planEndDate: string; count: number }) =>
    req<{ schedule: { planStartDate: string; planEndDate: string }[] }>('POST', '/api/v1/projects/preview-schedule', body),
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
  tokens: () => req<{ tokens: { id: number; name: string; tokenPrefix: string; scope: string; createdAt: number; expiresAt: number; revokedAt?: number | null }[] }>('GET', '/api/v1/auth/tokens'),
  issueToken: (scope: string, name: string) => req<{ token: string; id: number; scope: string; expiresAt: number }>('POST', '/api/v1/auth/tokens', { scope, name }),
  revokeToken: (id: number) => req('DELETE', `/api/v1/auth/tokens/${id}`),
}
