-- S58（v0.64，design.md K42）：任务备注域——「怎么干」的静态说明（带什么材料/照什么口径/注意事项），
-- ≤200 字（引擎校验，卡片渲染同上限截断）。模板默认值：类型内嵌清单配默认备注，立项随任务拷贝；
-- 实例独立改不回写类型；纯提醒/逾期预警/个人梳理/晨报推送携带备注。
ALTER TABLE tasks ADD COLUMN note TEXT; -- 任务备注（≤200 字；与 task_records 追加留痕、task_refs 链接备注互补）
ALTER TABLE project_type_tasks ADD COLUMN note TEXT; -- 类型任务清单默认备注（立项时随任务拷贝进实例）
