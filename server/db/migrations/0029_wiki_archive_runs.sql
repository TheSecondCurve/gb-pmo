-- S63（v0.68，design.md K48）：项目群全量汇总归档台账——每次「生成项目汇总」一行。
-- 状态机 running→done|failed；stage 供前端轮询展示进度；统计列如实记录口径（截断标 truncated）；
-- first_block_id 是幂等替换锚点（重跑先按它定位旧生成区删除，丢失时按标记行前缀扫描兜底）。
CREATE TABLE IF NOT EXISTS wiki_archive_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  status TEXT NOT NULL DEFAULT 'running',   -- running|done|failed
  stage TEXT,                               -- fetch|summarize|images|write|done（进度展示）
  message_count INTEGER,                    -- 参与汇总的有效文本消息数（已滤机器人/空文本）
  chunk_count INTEGER,                      -- LLM 分块数
  quotes_count INTEGER,                     -- 入选金句数
  image_count INTEGER,                      -- 成功归档图片数
  truncated INTEGER NOT NULL DEFAULT 0,     -- 量护栏触发截断/抽样
  first_block_id TEXT,                      -- 本次生成区首块 block_id（幂等替换锚点）
  page_url TEXT,                            -- 完成后页面可点链接
  error TEXT,                               -- failed 时中文原因
  created_by INTEGER,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_wiki_archive_runs_project ON wiki_archive_runs(project_id, id);
