-- 0005_project_types.sql — 项目类型与任务模板拆分（PRD v0.5 / S17-8）
-- 一类型绑定一个默认任务模板（default_template_id），多类型可共用同一模板；
-- 立项时选类型即套用其模板；projects.template_code 保留为立项时的应用快照（历史事实，不回改）。

CREATE TABLE IF NOT EXISTS project_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,                     -- software_delivery | consulting | custom | 自定义
  name TEXT NOT NULL,
  description TEXT,
  default_template_id INTEGER NOT NULL REFERENCES project_templates(id),
  status TEXT NOT NULL DEFAULT 'active',         -- active | disabled
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_project_types_status ON project_types(status);

-- 立项所选项目类型（typeCode 入参时写入；历史/Agent 直插可留空）
ALTER TABLE projects ADD COLUMN project_type_id INTEGER REFERENCES project_types(id);

-- 种子：按同 code 1:1 绑定现有模板（幂等：INSERT OR IGNORE）
INSERT OR IGNORE INTO project_types (code, name, description, default_template_id, status, created_at, updated_at)
SELECT t.code, t.name, t.description, t.id, 'active', 0, 0 FROM project_templates t
WHERE t.code IN ('software_delivery', 'consulting', 'custom');

-- 历史项目回填 project_type_id（template_code 同 code 映射）
UPDATE projects SET project_type_id = (SELECT pt.id FROM project_types pt WHERE pt.code = projects.template_code)
WHERE project_type_id IS NULL
  AND EXISTS (SELECT 1 FROM project_types pt WHERE pt.code = projects.template_code);
