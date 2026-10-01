-- S24 Web AI 助手会话（v0.16）：会话与消息持久化。
-- 会话本人专属（软删）；消息 user/assistant 双方全量落库，meta 为 JSON（result/llmCalls/queries/sql/eventId）。
-- 审计与限额走既有 bot_commands（platform='web'，message_id='web:<消息行id>' 天然唯一）。
CREATE TABLE IF NOT EXISTS chat_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER NOT NULL REFERENCES members(id),
  title TEXT NOT NULL DEFAULT '新会话',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,             -- 最后活跃时刻（列表排序）
  deleted_at INTEGER                      -- 软删时刻（NULL=在用）
);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_member ON chat_sessions(member_id, deleted_at, updated_at);

CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES chat_sessions(id),
  role TEXT NOT NULL,                     -- user / assistant
  content TEXT NOT NULL,
  meta TEXT,                              -- JSON：{result, llmCalls, queries, sql[], eventId?, writeKind?}
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id, id);
