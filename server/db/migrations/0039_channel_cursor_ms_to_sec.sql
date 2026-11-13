-- 0039_channel_cursor_ms_to_sec.sql — 游标毫秒→秒归一（K70 修订，v0.89）
-- 缺陷：fetchMessages 未归一飞书 create_time 混合单位（文本 10 位秒 / 图片·文件 13 位毫秒），
-- 任一图片消息把 nextCursor 以毫秒写入 channels.cursor → 下轮 start_time 按秒解释溢出成公元 5 万年，
-- 飞书 API 拒绝、抽取「失败不推进游标」→ 渠道 API 拉取永久冻结（线上 18/18 渠道实证）。
-- 修正：13 位存量统一转秒；回看窗封顶 7 天——游标从冻结点重放时，im_buffer 已消费行只保留 7 天
-- （pruneBuffer 滚动删），更深的历史消息会绕过双源去重被重新抽取，而 record 型事件无 operation_key
-- 幂等键，重放即重复（S3-6 不回灌语义之外的兜底护栏）。
UPDATE channels
SET cursor = CAST(MAX(CAST(cursor AS INTEGER) / 1000, CAST(strftime('%s', 'now') AS INTEGER) - 604800) AS TEXT)
WHERE length(cursor) = 13;
