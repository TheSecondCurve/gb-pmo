// 中央枚举：状态一律用这里，不散落字符串（AGENTS.md §4）。
// 双向对齐要求（engineering-standards §4）：每个枚举值必须有中文 label；
// gen-skill-schema.mjs 会把本文件渲染进 SKILL.md，drift check 比对。

export const ENUMS = {
  memberRole: { admin: '管理员', member: '普通成员' },
  memberStatus: { active: '在职', offboarded: '离职' },
  projectStatus: { planning: '待启动', active: '进行中', paused: '已暂停', closed: '已结项', cancelled: '已取消' },
  priority: { high: '高', medium: '中', low: '低' },
  taskStatus: { todo: '未开始', doing: '进行中', blocked: '被阻塞', done: '已完成', cancelled: '已取消' },
  taskSource: { template: '模板', manual: '手动', extraction: '抽取', suggestion: '建议采纳' },
  milestoneStatus: { planned: '计划中', met: '已达成', missed: '已延误', cancelled: '已取消' },
  dependencyStatus: { pending: '待满足', satisfied: '已满足', overdue: '已逾期' },
  channelPlatform: { feishu: '飞书', wecom: '企业微信' },
  channelType: { dedicated: '专题渠道', general: '通用群' },
  eventNature: { record: '记录型', suggestion: '建议型' },
  eventType: {
    progress: '进展',
    risk: '风险',
    decision: '决策',
    blocker: '阻塞',
    schedule_change: '排期变更',
    status_change: '状态变更',
    suggestion: '建议',
    owner_change: '责任人变更',
    priority_change: '优先级变更',
  },
  eventStatus: { pending: '待确认', effective: '已生效', rejected: '已驳回', expired: '已超时' },
  eventGenerator: { extraction: 'IM 抽取', digest: '梳理建议', agent: 'Agent 口述', web: '页面操作', system: '系统' },
  pushType: { daily_report: '日报', digest: '梳理', alert: '预警', test: '测试' },
  tokenScope: { read: '只读', write: '读写' },
}

export function label(group, value) {
  const map = ENUMS[group]
  if (!map) throw new Error(`unknown enum group: ${group}`)
  return map[value] || value
}

export function values(group) {
  const map = ENUMS[group]
  if (!map) throw new Error(`unknown enum group: ${group}`)
  return Object.keys(map)
}

export function assertValue(group, value) {
  if (!(value in ENUMS[group])) {
    throw Object.assign(new Error(`invalid ${group}: ${value}`), { statusCode: 400 })
  }
  return value
}

// 阈值默认值（配置台 settings 可覆盖；PRD K5）
export const DEFAULT_SETTINGS = {
  thresholds: {
    silentDays: 7,
    keypersonMaxProjects: 3,
    acceptanceAlarm: 0.7,
    suggestTimeoutHours: 48,
    routingConfidence: 0.6,
    healthRed: { silentDays: 7, overdue: 3 },
    healthYellow: { silentDays: 3, overdue: 1 },
  },
  push: { dailyReportHour: 18 },
  llm: { baseUrl: 'https://api.deepseek.com', apiKey: '', model: 'deepseek-chat', timeoutMs: 60000 },
  'im.feishu': { appId: '', appSecret: '' },
  'im.wecom': { corpId: '', secret: '', publicKeyVer: '', privateKey: '', sdkUrl: '' },
}
