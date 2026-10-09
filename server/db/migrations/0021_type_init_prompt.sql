-- 0021_type_init_prompt.sql — v0.42（PRD S39 / design.md K21）：项目类型初始化提示词。
-- 管理员用自然语言沉淀该类项目的任务分配与倒排日期基本逻辑（≤2000 字、可空）；
-- AI 初始分配（brain/initAssign.js 草案 → applyInitAssignments 应用）读取它批量完成初次分配。
-- 存量类型为 NULL = 未配置（走通用兜底规则），行为与升级前一致。
ALTER TABLE project_types ADD COLUMN init_prompt TEXT;   -- 初始化提示词（NULL=未配置）
