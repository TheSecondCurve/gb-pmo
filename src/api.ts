// 手写 fetch 封装：统一凭据、统一错误（ApiError），每个端点一个具名方法
export class ApiError extends Error {
  constructor(public status: number, message: string, public data?: unknown) {
    super(message)
  }
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
  closeProject: (id: number, body: Record<string, unknown>) => req<import('./types').ProjectDetail>('POST', `/api/v1/projects/${id}/close`, body), // v0.6：body 仅 summary（结项规则=全部任务完成）
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
  createMilestone: (p: Record<string, unknown>) => req('POST', '/api/v1/milestones', p),
  patchMilestone: (id: number, p: Record<string, unknown>) => req('PATCH', `/api/v1/milestones/${id}`, p),

  confirmEvent: (id: number) => req('POST', `/api/v1/events/${id}/confirm`, {}),
  rejectEvent: (id: number) => req('POST', `/api/v1/events/${id}/reject`, {}),
  pendingEvents: () => req<{ events: import('./types').EventRow[] }>('GET', '/api/v1/events/pending'),

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
  adminTemplates: () => req<{ templates: import('./types').TemplateRow[] }>('GET', '/api/v1/admin/templates'),
  createTemplate: (p: Record<string, unknown>) => req<{ template: import('./types').TemplateRow }>('POST', '/api/v1/admin/templates', p),
  patchTemplate: (id: number, p: Record<string, unknown>) => req<{ template: import('./types').TemplateRow }>('PATCH', `/api/v1/admin/templates/${id}`, p),
  deleteTemplate: (id: number) => req('DELETE', `/api/v1/admin/templates/${id}`),
  draftTemplateTasks: (body: { name: string; description?: string }) =>
    req<{ tasks: string[] }>('POST', '/api/v1/admin/templates/draft', body),
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
  // S22 飞书项目日历：初始化（创建组织级日历）/ 立即同步（对账式）
  calendarInit: () => req<{ calendarId: string }>('POST', '/api/v1/admin/calendar/init', {}),
  calendarSync: () => req<{ calendarId: string; created: number; updated: number; skipped: number; errors: { projectId: number; name: string; error: string }[] } | { skipped: boolean; reason: string }>('POST', '/api/v1/admin/calendar/sync', {}),
  tokens: () => req<{ tokens: { id: number; name: string; tokenPrefix: string; scope: string; createdAt: number; expiresAt: number; revokedAt?: number | null }[] }>('GET', '/api/v1/auth/tokens'),
  issueToken: (scope: string, name: string) => req<{ token: string; id: number; scope: string; expiresAt: number }>('POST', '/api/v1/auth/tokens', { scope, name }),
  revokeToken: (id: number) => req('DELETE', `/api/v1/auth/tokens/${id}`),
}
