-- 0034_scheduler_runs.sql — 定时任务运行台账（S67-6，v0.77）：cron 与手动触发（S67-5）统一落行，
-- 配置台「定时任务→运行记录」可读；origin 限 cron/manual，summary 为 JSON 摘要（成功=结果要点，失败=错误消息）。
CREATE TABLE IF NOT EXISTS scheduler_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('cron', 'manual')),
  started_at INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  ok INTEGER NOT NULL DEFAULT 1,
  summary TEXT,
  member_id INTEGER REFERENCES members(id),
  created_at INTEGER NOT NULL
);
