-- 0003_events_target_object.sql — 建议型事件的目标对象（task | milestone）
ALTER TABLE project_events ADD COLUMN target_object TEXT NOT NULL DEFAULT 'task';
