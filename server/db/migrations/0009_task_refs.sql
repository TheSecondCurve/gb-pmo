-- S23 任务参考资料（v0.13）：任务可挂手工维护的 SOP/知识库链接（1 任务 N 条），
-- 供任务执行人参考；日报「我的任务」/逾期预警/个人梳理推送附带标题+链接（接收方信息完整）。
-- 约定：软删（deleted_at 落值，列表过滤）；结项/取消后任务面（含参考资料）只读。
CREATE TABLE IF NOT EXISTS task_refs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  title TEXT NOT NULL,                           -- 名称（如「部署 SOP」「验收知识库」）
  url TEXT NOT NULL,                             -- 链接（http/https；飞书文档/wiki 均可）
  note TEXT,                                     -- 备注（可选：适用时机/范围）
  created_by INTEGER REFERENCES members(id),
  created_at INTEGER NOT NULL,
  deleted_at INTEGER                             -- 软删时刻（NULL=在用）
);
CREATE INDEX IF NOT EXISTS idx_task_refs_task ON task_refs(task_id, deleted_at);
