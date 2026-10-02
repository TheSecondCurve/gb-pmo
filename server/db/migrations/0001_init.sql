-- 0001_init.sql — gb-pmo 初始结构
-- 约定：snake_case 列名（Agent SQL 端点直连本结构，SKILL.md 同步文档化）；
--       时间戳 epoch 毫秒 INTEGER；日期 TEXT(YYYY-MM-DD)；软删用状态枚举，不物理删除。

CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  feishu_id TEXT UNIQUE,
  wecom_id TEXT UNIQUE,
  team TEXT,
  is_key_person INTEGER NOT NULL DEFAULT 0,
  max_parallel_projects INTEGER NOT NULL DEFAULT 3,
  role TEXT NOT NULL DEFAULT 'member',          -- admin | member
  status TEXT NOT NULL DEFAULT 'active',        -- active | offboarded
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES members(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER NOT NULL REFERENCES members(id),
  name TEXT NOT NULL DEFAULT 'agent',
  token_prefix TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL DEFAULT 'read',           -- read | write
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoked_by INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tokens_member ON tokens(member_id);

CREATE TABLE IF NOT EXISTS project_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,                    -- software_delivery | consulting | custom
  name TEXT NOT NULL,
  description TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS template_stages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id INTEGER NOT NULL REFERENCES project_templates(id),
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS template_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id INTEGER NOT NULL REFERENCES project_templates(id),
  stage_name TEXT NOT NULL,
  title TEXT NOT NULL,
  sort_order INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  template_code TEXT NOT NULL DEFAULT 'custom',
  status TEXT NOT NULL DEFAULT 'planning',      -- active|closed|cancelled（S29 三态；planning/paused 已由 0016 归一，DEFAULT 为历史遗留，engine 始终显式赋值）
  priority TEXT NOT NULL DEFAULT 'medium',      -- high|medium|low
  lead_member_id INTEGER NOT NULL REFERENCES members(id),
  client_name TEXT,
  plan_start_date TEXT,
  plan_end_date TEXT,
  actual_start_date TEXT,
  actual_end_date TEXT,
  closeout_summary TEXT,
  created_by INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
CREATE INDEX IF NOT EXISTS idx_projects_lead ON projects(lead_member_id);

CREATE TABLE IF NOT EXISTS stages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stages_project ON stages(project_id);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  stage_id INTEGER REFERENCES stages(id),
  title TEXT NOT NULL,
  responsible_member_id INTEGER REFERENCES members(id),
  status TEXT NOT NULL DEFAULT 'todo',          -- todo|doing|blocked|done|cancelled
  plan_start_date TEXT,
  plan_end_date TEXT,
  actual_end_date TEXT,
  source TEXT NOT NULL DEFAULT 'manual',        -- template|manual|extraction|suggestion
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks(responsible_member_id);

CREATE TABLE IF NOT EXISTS milestones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  plan_date TEXT,
  actual_date TEXT,
  status TEXT NOT NULL DEFAULT 'planned',      -- planned|met|missed|cancelled
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_milestones_project ON milestones(project_id);

CREATE TABLE IF NOT EXISTS dependencies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  depends_on_task_id INTEGER REFERENCES tasks(id),
  depends_on_member_id INTEGER REFERENCES members(id),
  note TEXT,
  due_date TEXT,
  status TEXT NOT NULL DEFAULT 'pending',       -- pending|satisfied|overdue
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_deps_task ON dependencies(task_id);
CREATE INDEX IF NOT EXISTS idx_deps_member ON dependencies(depends_on_member_id);

CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,                       -- feishu|wecom
  group_key TEXT NOT NULL,
  name TEXT,
  channel_type TEXT NOT NULL DEFAULT 'dedicated', -- dedicated|general
  project_id INTEGER REFERENCES projects(id),
  cursor TEXT,
  last_pull_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(platform, group_key)
);
CREATE INDEX IF NOT EXISTS idx_channels_project ON channels(project_id);

CREATE TABLE IF NOT EXISTS project_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  business_time INTEGER NOT NULL,               -- 消息发生/业务时间
  created_at INTEGER NOT NULL,                  -- 系统时间（抽取时间）
  nature TEXT NOT NULL DEFAULT 'record',        -- record|suggestion
  event_type TEXT NOT NULL,                     -- progress|risk|decision|blocker|schedule_change|status_change|suggestion|owner_change
  summary TEXT NOT NULL,
  raw_snapshot TEXT,
  source_platform TEXT NOT NULL DEFAULT 'web',  -- feishu|wecom|web|agent|brain
  source_ref TEXT,
  speaker_member_id INTEGER REFERENCES members(id),
  speaker_label TEXT,
  confidence REAL,
  status TEXT NOT NULL DEFAULT 'effective',     -- pending|effective|rejected|expired
  target_task_id INTEGER REFERENCES tasks(id),
  target_field TEXT,                            -- status|plan_end_date|responsible_member_id|priority|depends_on
  target_value TEXT,
  decided_by INTEGER,
  decided_at INTEGER,
  generated_by TEXT NOT NULL DEFAULT 'extraction', -- extraction|digest|agent|web|system
  pushed_to TEXT                                -- JSON 数组：已推送成员 id
);
CREATE INDEX IF NOT EXISTS idx_events_project ON project_events(project_id, business_time);
CREATE INDEX IF NOT EXISTS idx_events_status ON project_events(status);

CREATE TABLE IF NOT EXISTS unrouted_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  group_key TEXT NOT NULL,
  business_time INTEGER NOT NULL,
  speaker_label TEXT,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',          -- open|routed|discarded
  routed_project_id INTEGER REFERENCES projects(id),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pushes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  push_type TEXT NOT NULL,                      -- daily_report|digest|alert|test
  recipient_member_id INTEGER REFERENCES members(id),
  related_project_id INTEGER REFERENCES projects(id),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  channel_platform TEXT,
  status TEXT NOT NULL DEFAULT 'sent',          -- sent|failed|skipped
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pushes_recipient ON pushes(recipient_member_id);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,                          -- JSON
  updated_at INTEGER NOT NULL,
  updated_by INTEGER
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER,
  action TEXT NOT NULL,
  object_type TEXT,
  object_id TEXT,
  detail TEXT,                                  -- JSON
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);

CREATE TABLE IF NOT EXISTS migrations_meta (
  name TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
