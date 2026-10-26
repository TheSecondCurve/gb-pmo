// 配置台信息架构（PRD v0.5 / S17）：二级菜单 + 每页 Tab 的唯一配置处
// 独立模块避免 Admin Shell 与各 section 页面循环依赖
export const ADMIN_SECTIONS: { key: string; label: string; tabs: { key: string; label: string }[] }[] = [
  {
    key: 'project', label: '项目管理',
    tabs: [
      { key: 'types', label: '项目类型' },
      { key: 'channels', label: '渠道' },
      { key: 'params', label: '阈值与推送' },
    ],
  },
  // S67（v0.75，K53）：全部调度任务集中一页（cron + 启用开关），从「项目管理→阈值与推送」独立
  {
    key: 'scheduler', label: '定时任务',
    tabs: [
      { key: 'tasks', label: '任务与开关' },
    ],
  },
  {
    key: 'users', label: '用户管理',
    tabs: [
      { key: 'members', label: '成员身份' },
      { key: 'tokens', label: '令牌治理' },
    ],
  },
  {
    key: 'integrations', label: '外部依赖',
    tabs: [
      { key: 'llm', label: 'LLM' },
      { key: 'feishu', label: '飞书' },
      { key: 'wecom', label: '企业微信' },
    ],
  },
  {
    key: 'ops', label: '运维诊断',
    tabs: [
      { key: 'shell', label: '诊断 Shell' },
      { key: 'selfcheck', label: '飞书自检' },
      { key: 'backup', label: '数据库备份' },
    ],
  },
]
