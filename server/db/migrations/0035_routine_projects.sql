-- 0035_routine_projects.sql — S69（v0.80，design.md K64）：常态项目与每周执行周视图
-- 建模：项目类别（delivery|routine，立项选定后不可变更）+ 常态任务（kind=routine，K40 第三档）
-- 带适用星期（CSV 1=周一…7=周日，缺省全周）+ 每日执行记录表（(task_id, day) 唯一，惰性 upsert——
-- 不预生成实例，无记录=未做；status 只有 done|skip，重置=删行）。

ALTER TABLE projects ADD COLUMN kind TEXT NOT NULL DEFAULT 'delivery'; -- 项目类别：delivery=交付项目 | routine=常态项目（S69：立项选定后不可变更，常态无交付日期、结项豁免「全部任务完成」）
ALTER TABLE tasks ADD COLUMN weekdays TEXT;                            -- 适用星期 CSV（1=周一…7=周日）；仅 kind=routine 任务有值，NULL=非常态

CREATE TABLE IF NOT EXISTS task_day_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  day TEXT NOT NULL,                                             -- 北京日历日 YYYY-MM-DD（S19）
  status TEXT NOT NULL CHECK (status IN ('done', 'skip')),       -- 未做=无记录行（K64：不预生成实例）
  note TEXT NOT NULL DEFAULT '',                                 -- 当日执行备注（≤200 字，记录型字段）
  operator_member_id INTEGER REFERENCES members(id),
  source TEXT NOT NULL DEFAULT 'web',                            -- web | bot（打卡来源通道）
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(task_id, day)
);
CREATE INDEX IF NOT EXISTS idx_task_day_records_day ON task_day_records(day);

-- 预置「常态项目」类型（空清单：常态项目任务走自定义清单/逐条添加；K11 类型机制照常可用）
INSERT OR IGNORE INTO project_types (code, name, description, init_prompt, status, created_at, updated_at)
VALUES ('routine_ops', '常态项目', '日常重复执行的常态化项目（每周执行周视图、每日打卡，S69）', NULL, 'active', 0, 0);
