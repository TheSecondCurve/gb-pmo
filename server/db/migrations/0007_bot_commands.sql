-- S20 机器人指令通道（v0.11）：指令审计与去重 + 飞书绑定码。
-- message_id UNIQUE = 飞书重复投递/卡片与消息同 id 的幂等键；
-- 机器人自身发出的回复也落行（kind='bot_reply'），供定时抽取按 message_id 去重。
CREATE TABLE IF NOT EXISTS bot_commands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL UNIQUE,
  platform TEXT NOT NULL DEFAULT 'feishu',
  chat_id TEXT,
  chat_type TEXT,
  sender_open_id TEXT,
  member_id INTEGER REFERENCES members(id),
  kind TEXT NOT NULL DEFAULT 'command',
  raw_text TEXT,
  intent TEXT,
  detail TEXT,
  result TEXT,
  llm_calls INTEGER,
  duration_ms INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bot_commands_member_day ON bot_commands(member_id, created_at);

-- 飞书账号绑定码：web 生成（10 分钟、单次），仅私聊 /bind 消费；只存 hash。
CREATE TABLE IF NOT EXISTS bot_bind_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER NOT NULL REFERENCES members(id),
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);
