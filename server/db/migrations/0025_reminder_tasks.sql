-- S57（v0.62，design.md K40）：纯提醒任务分类——到期一次性推送（责任人私聊 + 项目专题群）后自动完成，不进逾期追踪口径
ALTER TABLE tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'work'; -- 任务分类：work=工作（进追踪口径）| reminder=纯提醒（S57，发完即自动完成）
ALTER TABLE tasks ADD COLUMN reminded_at INTEGER;               -- 提醒已送达时刻（幂等锚点：改期/人工重开时重置以重新武装）
ALTER TABLE pushes ADD COLUMN group_key TEXT;                   -- 群推送目标（专题渠道 group_key；NULL=成员私聊，S57）
