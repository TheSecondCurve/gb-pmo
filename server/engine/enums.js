// 中央枚举：状态一律用这里，不散落字符串（AGENTS.md §4）。
// 双向对齐要求（engineering-standards §4）：每个枚举值必须有中文 label；
// gen-skill-schema.mjs 会把本文件渲染进 SKILL.md，drift check 比对。

export const ENUMS = {
  memberRole: { admin: '系统管理员', member: '成员' },
  memberStatus: { active: '在职', offboarded: '离职' },
  projectStatus: { planning: '待启动', active: '进行中', paused: '已暂停', closed: '已结项', cancelled: '已取消' },
  projectTypeStatus: { active: '启用', disabled: '停用' },
  priority: { high: '高', medium: '中', low: '低' },
  // v0.6：任务状态固定三档（无 blocked/cancelled；任务相互独立，无前置依赖）
  taskStatus: { todo: '未开始', doing: '进行中', done: '完成' },
  taskSource: { template: '模板', manual: '手动', extraction: '抽取', suggestion: '建议采纳' },
  milestoneStatus: { planned: '计划中', met: '已达成', missed: '已延误', cancelled: '已取消' },
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
  // S20 机器人指令通道：指令/卡片/机器人回复三类记录 + 结果枚举（bot_commands.result）
  botCommandKind: { command: '指令', card: '卡片回调', bot_reply: '机器人回复' },
  botCommandResult: {
    replied: '已回复', clarified: '已追问', guidance: '绑定引导', bound: '已绑定',
    card_sent: '已发确认卡', confirmed: '已确认生效', rejected: '已驳回',
    refused_permission: '权限不足', refused_quota: '超出限额', refused_external: '外部群拒答',
    refused_unregistered: '未登记群拒答', ignored_unbound: '未绑定忽略', ignored_dedup: '重复忽略',
    no_llm: 'LLM 未配置', error: '错误',
  },
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

// LLM 供应商目录（S17-11，v0.14）：类别枚举 + 默认 baseUrl/model，适配层（brain/llm.js）与配置台共用；均可覆写。
// glm-coding = GLM 国内 Coding Plan：官方指定自建工具走 OpenAI 兼容编码端点（Claude Code 等官方客户端才走 /api/anthropic）。
export const LLM_PROVIDERS = {
  deepseek: { label: 'DeepSeek（OpenAI 兼容）', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
  'glm-coding': { label: 'GLM 国内 Coding Plan（智谱）', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', model: 'glm-5.3' },
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
  push: { dailyReportHour: 18 }, // v0.7 废弃：日报时点由 scheduler.reportCron 取代（保留兼容旧配置）
  scheduler: {
    extractionCron: '0 * * * *',   // 信息更新对齐（S18，默认每小时）
    extractionEnabled: true,
    alertCron: '*/15 * * * *',     // 预警提醒（默认每 15 分钟）
    alertEnabled: true,
    reportCron: '0 18 * * *',      // 日报提醒（默认每日 18:00）
    reportEnabled: true,
    calendarSyncCron: '*/30 * * * *', // 项目日历同步（S22，默认每 30 分钟）
    calendarSyncEnabled: true,
  },
  // S22 项目日历：feishuCalendarId 空=未初始化（配置台「外部依赖→飞书」初始化写入；同步任务静默跳过）
  calendar: { feishuCalendarId: '' },
  // v0.15（S17-11）：LLM 按类别分开存储——各类别独立 apiKey/baseUrl/model（互不覆盖），provider=当前生效类别，
  // timeoutMs 全局共用；存量扁平行由 migration 0010 迁移。
  llm: {
    provider: 'deepseek',
    deepseek: { apiKey: '', baseUrl: LLM_PROVIDERS.deepseek.baseUrl, model: LLM_PROVIDERS.deepseek.model },
    'glm-coding': { apiKey: '', baseUrl: LLM_PROVIDERS['glm-coding'].baseUrl, model: LLM_PROVIDERS['glm-coding'].model },
    timeoutMs: 60000,
  },
  'im.feishu': {
    appId: '', appSecret: '',
    botEnabled: false,                       // S20 机器人指令通道总开关（默认关）
    botModes: { p2p: true, groupAt: true },  // 私聊 / 群@ 两个入口
    answerUnregisteredGroups: true,          // 未登记群是否响应项目问答（写需显式指项目）
    commandQuotaPerDay: 50,                  // 每成员每日自然语言指令限额（北京日）
    contextTurns: 8,                         // S20-13 多轮上下文注入条数上限（0=整体关闭记忆）
    contextIdleMinutes: 120,                 // S20-14 空闲超时（分钟）静默开新会话
  },
  'im.wecom': { corpId: '', secret: '', publicKeyVer: '', privateKey: '', sdkUrl: '' },
  // S26（v0.19）管理员诊断台：诊断 shell 等价容器执行权——开关默认关，仅可信内网排障用，全程审计
  debug: { shellEnabled: false, timeoutMs: 10000, maxOutputBytes: 131072 },
  // S24 Web AI 助手会话：每成员每日指令限额（北京日，与 bot_commands 审计同口径）
  chat: { quotaPerDay: 50 },
}
