-- S20-13/14（v0.23）机器人多轮上下文：/new 水位线（append-only，不删审计行）+ 会话历史查询索引。
-- 会话域 = (platform, chat_id)：私聊天然按用户隔离，群聊全群共享。
CREATE TABLE IF NOT EXISTS bot_context_resets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL DEFAULT 'feishu',
  chat_id TEXT NOT NULL,
  member_id INTEGER REFERENCES members(id),
  message_id TEXT,               -- 触发清空的那条消息（审计溯源）
  cleared_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bot_context_resets_scope ON bot_context_resets(platform, chat_id, cleared_at);
CREATE INDEX IF NOT EXISTS idx_bot_commands_chat_time ON bot_commands(platform, chat_id, created_at);
