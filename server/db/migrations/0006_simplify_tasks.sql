-- 0006_simplify_tasks.sql — v0.6 简化：模板扁平化 / 任务状态三档 / 依赖裁剪 / 任务更新记录
-- 模板 = 纯任务清单（无阶段层）；项目不再有阶段；任务间不设前置依赖；
-- 任务状态固定三档（todo/doing/done），存量 blocked/cancelled 归一化；
-- 新增任务更新记录（append-only，只插不改）。

DROP INDEX IF EXISTS idx_tasks_depends;
ALTER TABLE tasks DROP COLUMN depends_on_task_id;
ALTER TABLE tasks DROP COLUMN stage_id;
DROP TABLE stages;

ALTER TABLE template_tasks DROP COLUMN stage_name;
DROP TABLE template_stages;

DROP TABLE dependencies;

-- 存量状态归一：被阻塞 → 未开始；已取消（已记实际结束日）→ 完成，否则 → 未开始
UPDATE tasks SET status = 'todo' WHERE status = 'blocked';
UPDATE tasks SET status = 'done' WHERE status = 'cancelled' AND actual_end_date IS NOT NULL;
UPDATE tasks SET status = 'todo' WHERE status = 'cancelled';

CREATE TABLE IF NOT EXISTS task_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  member_id INTEGER REFERENCES members(id),
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_records_task ON task_records(task_id, created_at);
