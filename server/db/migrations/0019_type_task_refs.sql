-- 0019_type_task_refs.sql — v0.33（PRD S33）：类型模板任务参考资料。
-- 模板任务从纯标题扩展为「标题 + 可选参考链接列表」：子表挂 project_type_tasks，
-- 结构镜像实例侧 task_refs（0009/S23）去掉软删/创建人——模板是配置对象，编辑=整体替换、
-- 变更历史走 projectType.update 审计；立项时参考随标题同事务拷贝进 task_refs（创建人=立项人），
-- 落表即被 S23 全套能力接管（参考弹窗/「参考 N」徽标/日报/预警/梳理推送附带/结项只读）。
-- 存量预置类型（0017/0018）不回填：自动按步骤名挂链接易挂错，由管理员按知识库 SOP 在配置台补挂。
-- project_type_tasks 一列不动；新表空=无参考，行为同 v0.32。

CREATE TABLE IF NOT EXISTS project_type_task_refs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type_task_id INTEGER NOT NULL REFERENCES project_type_tasks(id),
  title TEXT NOT NULL,                           -- 名称（如「预热文案模板」「设备预检清单」）
  url TEXT NOT NULL,                             -- 链接（http/https；飞书文档/wiki 均可）
  note TEXT,                                     -- 备注（可选：适用时机/范围）
  sort_order INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_project_type_task_refs ON project_type_task_refs(type_task_id, sort_order);
