-- 0004_tasks_dependency.sql — 任务前置依赖列（S2-2 任务→任务阻塞链）
ALTER TABLE tasks ADD COLUMN depends_on_task_id INTEGER REFERENCES tasks(id);
CREATE INDEX IF NOT EXISTS idx_tasks_depends ON tasks(depends_on_task_id);
