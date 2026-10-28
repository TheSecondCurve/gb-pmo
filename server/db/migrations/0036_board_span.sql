-- 0036_board_span.sql — S69-8（v0.81，design.md K65）：常态项目执行视图默认窗口
-- 三档 span（week|biweek|month，中央枚举 boardSpan；缺省 week）。仅常态项目可设（交付项目设值 400），
-- 解析序 = 请求参数 → 项目默认 → 周。窗口数学在 engine/dailyBoard.js 的 BOARD_SPANS（存储无窗口概念）。

ALTER TABLE projects ADD COLUMN board_span TEXT NOT NULL DEFAULT 'week'; -- 常态项目执行视图默认窗口：week=周 | biweek=双周 | month=月
