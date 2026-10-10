-- S52（v0.57，design.md K35）：事件驱动抽取缓冲——长连接网关把已绑定渠道的非 @ 群消息落缓冲表，
-- 定时抽取先排干缓冲再走 API 游标对账；consumed_at 行保留 7 天供双源去重（API 重拉已消费消息跳过），滚动清理。
CREATE TABLE IF NOT EXISTS im_buffer (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  group_key TEXT NOT NULL,
  message_id TEXT NOT NULL UNIQUE,     -- 全局去重键（网关重复投递/多源汇入幂等）
  speaker_id TEXT,
  speaker_label TEXT,
  text TEXT NOT NULL,
  ts INTEGER NOT NULL,                 -- 消息时刻（epoch 毫秒）
  consumed_at INTEGER,                 -- 抽取排干时刻；NULL=待消费
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_im_buffer_channel ON im_buffer(platform, group_key, consumed_at);
