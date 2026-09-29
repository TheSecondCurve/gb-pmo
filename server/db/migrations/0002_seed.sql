-- 0002_seed.sql — 预置模板（PRD K5：软件交付 + 咨询服务 + 自由创建锚点）
-- created_at 用 0 表示种子数据（无真实业务时间）。

INSERT OR IGNORE INTO project_templates (code, name, description, created_at, updated_at) VALUES
  ('software_delivery', '软件交付', '对外软件/系统交付项目：需求 → 开发 → 测试 → 验收 → 结项', 0, 0),
  ('consulting', '咨询服务', '按阶段交付的专业服务：调研 → 方案 → 实施 → 结项', 0, 0),
  ('custom', '自由创建', '空项目，仅含启动/结项锚点，后续追加阶段', 0, 0);

INSERT INTO template_stages (template_id, name, sort_order)
SELECT t.id, s.name, s.sort_order FROM project_templates t
JOIN (SELECT '启动' AS name, 1 AS sort_order UNION ALL SELECT '需求', 2 UNION ALL SELECT '开发', 3 UNION ALL SELECT '测试', 4 UNION ALL SELECT '验收', 5 UNION ALL SELECT '结项', 6) s
WHERE t.code = 'software_delivery';

INSERT INTO template_stages (template_id, name, sort_order)
SELECT t.id, s.name, s.sort_order FROM project_templates t
JOIN (SELECT '启动' AS name, 1 AS sort_order UNION ALL SELECT '调研', 2 UNION ALL SELECT '方案', 3 UNION ALL SELECT '实施', 4 UNION ALL SELECT '结项', 5) s
WHERE t.code = 'consulting';

INSERT INTO template_stages (template_id, name, sort_order)
SELECT t.id, s.name, s.sort_order FROM project_templates t
JOIN (SELECT '启动' AS name, 1 AS sort_order UNION ALL SELECT '结项', 2) s
WHERE t.code = 'custom';

INSERT INTO template_tasks (template_id, stage_name, title, sort_order)
SELECT t.id, x.stage_name, x.title, x.sort_order FROM project_templates t
JOIN (SELECT '需求' AS stage_name, '需求确认与范围冻结' AS title, 1 AS sort_order UNION ALL
      SELECT '开发', '技术方案与排期', 2 UNION ALL
      SELECT '开发', '开发联调', 3 UNION ALL
      SELECT '测试', '测试与缺陷修复', 4 UNION ALL
      SELECT '验收', '客户验收', 5 UNION ALL
      SELECT '结项', '结项复盘', 6) x
WHERE t.code = 'software_delivery';

INSERT INTO template_tasks (template_id, stage_name, title, sort_order)
SELECT t.id, x.stage_name, x.title, x.sort_order FROM project_templates t
JOIN (SELECT '调研' AS stage_name, '现状调研与访谈' AS title, 1 AS sort_order UNION ALL
      SELECT '方案', '方案设计与评审', 2 UNION ALL
      SELECT '实施', '分阶段实施', 3 UNION ALL
      SELECT '结项', '结项复盘', 4) x
WHERE t.code = 'consulting';
