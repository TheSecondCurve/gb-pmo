-- S22 飞书项目日历（v0.12）：项目 ↔ 飞书全日事件的对账映射。
-- 对账式同步：期望内容 hash 不变则零 API 调用；结项/取消项目的事件保留不删（标题加终态前缀）。
CREATE TABLE IF NOT EXISTS calendar_sync (
  project_id INTEGER PRIMARY KEY REFERENCES projects(id),
  calendar_event_id TEXT NOT NULL,             -- 飞书 event_id（创建成功后写入）
  content_hash TEXT NOT NULL,                  -- 期望事件内容摘要（标题/描述/起止日），变则 patch
  synced_at INTEGER NOT NULL,                  -- 最近一次成功同步时刻（epoch 毫秒）
  last_error TEXT                              -- 最近一次 patch 失败原因（create 失败尚无映射行，错误只在同步结果回显）
);
