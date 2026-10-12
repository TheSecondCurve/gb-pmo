-- 0030_init_extra.sql — v0.69（PRD S64 / design.md K49）：项目级初始分配补充要求。
-- AI 初始分配的 LLM 输入按「类型 project_types.init_prompt → 项目 init_extra → 本次触发追加」三层
-- 依次拼装（未配置层跳过）；本列承载"这个项目本次特例"（≤2000 字、可空），立项可填、详情可改。
-- 存量项目为 NULL = 未配置，行为与升级前一致。
ALTER TABLE projects ADD COLUMN init_extra TEXT;   -- 项目级初始分配补充要求（叠加类型 init_prompt，≤2000 字，NULL=未配置）
