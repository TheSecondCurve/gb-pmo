-- 0032_extraction_auto_apply.sql — IM 抽取批量自动执行、候选对象决策与业务重放幂等
ALTER TABLE project_events ADD COLUMN operation_key TEXT;
ALTER TABLE project_events ADD COLUMN target_candidates TEXT;
ALTER TABLE project_events ADD COLUMN decided_candidate TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_operation_key ON project_events(operation_key) WHERE operation_key IS NOT NULL;
