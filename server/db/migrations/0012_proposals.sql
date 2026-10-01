-- S25 Agent 提议式项目与配置操作（v0.17）：通用提议→确认→生效。
-- LLM 只起草（payload 为解析后的提议载荷，确认前人可核对）；生效复用既有 engine 口子（审计/事件由 engine 承担）。
-- kind: update_project_status / close_project / create_project / create_project_type /
--       create_task_template / update_task_template
CREATE TABLE IF NOT EXISTS proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,                   -- JSON（解析后的提议载荷）
  summary TEXT NOT NULL,                   -- 人话摘要（确认卡/消息展示）
  status TEXT NOT NULL DEFAULT 'pending',  -- pending / effective / rejected
  proposed_by INTEGER REFERENCES members(id),
  decided_by INTEGER REFERENCES members(id),
  decided_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status, created_at);
