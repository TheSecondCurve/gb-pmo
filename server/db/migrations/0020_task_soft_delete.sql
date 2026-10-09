-- 0020_task_soft_delete.sql — v0.40（PRD S36 / design.md K18）：任务删除=软删。
-- tasks 加 deleted_at：删除落值、行保留留痕（审计 task.delete），对齐 task_refs（0009/S23）
-- 与 chat_sessions（0011）既有范式；不引入 cancelled 状态值（v0.6 三档状态口径不动，
-- 结项校验 `status != 'done'` 与指标 OPEN_TASK 零污染）。
-- 一切读侧以 `deleted_at IS NULL` 过滤（列表/详情/盘点/未指派/逾期/指标/日报/梳理/结项校验）；
-- task_refs 随任务删除同事务级联软删，task_records/project_events 保留（append-only 留痕）。
ALTER TABLE tasks ADD COLUMN deleted_at INTEGER;     -- 软删时刻（NULL=在用）
CREATE INDEX IF NOT EXISTS idx_tasks_project_deleted ON tasks(project_id, deleted_at);
