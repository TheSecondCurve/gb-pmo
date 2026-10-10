-- S47（v0.52，design.md K30）：LLM 用量记账——每次逻辑调用一行（S40 内部重试不重复计），费用审计数据基础
CREATE TABLE IF NOT EXISTS llm_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purpose TEXT NOT NULL,               -- extraction|routing|digest|closeout|draft|init_assign|chat（自由文本约定值）
  project_id INTEGER,                  -- 关联项目（可空；对话面/个人梳理无单项目语义）
  provider TEXT,                       -- 生效类别（deepseek|glm-coding；fake 注入时为适配器名）
  model TEXT,
  prompt_tokens INTEGER,               -- 上游 usage 返回时记录，无则 NULL
  completion_tokens INTEGER,
  duration_ms INTEGER,
  ok INTEGER NOT NULL DEFAULT 1,       -- 1 成功 / 0 失败（error 记摘要）
  error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_llm_calls_created ON llm_calls(created_at);
CREATE INDEX IF NOT EXISTS idx_llm_calls_purpose ON llm_calls(purpose, created_at);
