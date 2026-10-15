-- 0031_events_polymorphic_target.sql — project_events 目标 id 由 target_object 判别对象类型
-- 历史字段名 target_task_id 保持不变以兼容事件查询/确认链路，但里程碑目标不能受 tasks 外键约束。
ALTER TABLE project_events ADD COLUMN target_id_polymorphic INTEGER;
UPDATE project_events SET target_id_polymorphic = target_task_id;
ALTER TABLE project_events DROP COLUMN target_task_id;
ALTER TABLE project_events RENAME COLUMN target_id_polymorphic TO target_task_id;
