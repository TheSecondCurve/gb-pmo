-- S46（v0.51，design.md K29）：推送链路真实投递——投递失败原因与飞书消息 id 留痕
ALTER TABLE pushes ADD COLUMN error TEXT;        -- failed/skipped 的原因（排障依据）
ALTER TABLE pushes ADD COLUMN message_id TEXT;   -- 投递成功时飞书返回的消息 id
