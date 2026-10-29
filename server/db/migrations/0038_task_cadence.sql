-- 0038_task_cadence.sql — S75（v0.87，design.md K72）：常态任务周期四档
-- 适用星期单列（weekdays CSV，S69）升级为统一周期对象 tasks.cadence（JSON 文本）：
--   {"type":"daily"}                                            每日（缺省）
--   {"type":"weekly","weekdays":[1,3,5]}                        每周（星期组合，S69 语义原样）
--   {"type":"biweekly","weekdays":[1],"parity":0}               每两周（K65 纪元锚 2024-01-01 起每 14 天一期，periodIndex%2）
--   {"type":"monthly","monthDays":[1,15]}                       每月几号（当月无该日不适用，cron 语义）
-- 回填后删除 weekdays 列（单一真相源）；出参 weekdays 由 cadence 派生、入参 legacy weekdays 兼容映射。

ALTER TABLE tasks ADD COLUMN cadence TEXT; -- 常态任务周期 JSON（见上四档）；NULL=非常态任务（kind != routine）

UPDATE tasks SET cadence = CASE
  WHEN kind != 'routine' THEN NULL
  WHEN weekdays IS NULL OR weekdays = '1,2,3,4,5,6,7' THEN '{"type":"daily"}'
  ELSE '{"type":"weekly","weekdays":[' || weekdays || ']}'
END;

ALTER TABLE tasks DROP COLUMN weekdays;
