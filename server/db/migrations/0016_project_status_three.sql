-- 0016：S29（v0.28）项目状态收敛三态（active/closed/cancelled）。
-- planning/paused 裁撤：存量归一为 active；启动日空值补落（原 paused 激活时已落，
-- planning 从未激活——取计划开始日，缺失时取迁移当日；一次性历史数据回填，非应用逻辑）。
UPDATE projects SET status = 'active' WHERE status IN ('planning', 'paused');
UPDATE projects SET actual_start_date = COALESCE(plan_start_date, date('now')) WHERE actual_start_date IS NULL AND status = 'active';
