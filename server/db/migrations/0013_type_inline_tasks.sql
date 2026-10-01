-- 0013_type_inline_tasks.sql — v0.18（PRD S1-6/S17-8/K11）：任务模板并入项目类型（单对象，内嵌任务清单）。
-- 回填：各类型原默认模板（default_template_id）的任务清单 → 类型内嵌清单（project_type_tasks）。
-- projects.template_code 保留：立项时所选类型编码的快照（历史事实，不回改；语义从「模板码」变为「类型码」）。
-- createProject 的 templateCode 入参降级为 typeCode 的兼容别名（同码解析，见 engine/projectTypes.js）。

CREATE TABLE IF NOT EXISTS project_type_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type_id INTEGER NOT NULL REFERENCES project_types(id),
  title TEXT NOT NULL,
  sort_order INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_project_type_tasks_type ON project_type_tasks(type_id, sort_order);

-- 幂等回填（迁移器按文件名只跑一次；守卫防手工重放双写）
INSERT INTO project_type_tasks (type_id, title, sort_order)
SELECT pt.id, tt.title, tt.sort_order
FROM project_types pt
JOIN project_templates t ON t.id = pt.default_template_id
JOIN template_tasks tt ON tt.template_id = t.id
WHERE NOT EXISTS (SELECT 1 FROM project_type_tasks);

ALTER TABLE project_types DROP COLUMN default_template_id;
DROP TABLE IF EXISTS template_tasks;
DROP TABLE IF EXISTS project_templates;
