-- 0041_sales_records.sql — S79（v0.94，design.md K79）：销售成交登记域
-- 独立域：与项目/任务零耦合（不产 project_events、不进 metrics.js 项目指标）。
-- sales_messages = 消息级幂等台账（message_id 唯一；游标 = MAX(ts) 派生，无独立游标列）；
-- sales_records = 唯一真相源（业务级幂等 = 订单号部分唯一索引；无订单号按
-- 客户昵称+成交日+金额 组合查重兜底，引擎层判定不建索引防误伤）。
-- 多维表格是投影：synced_record_id 回填（NULL = 未同步，下轮补推）。deal_day 为北京日历日（S19）。

CREATE TABLE IF NOT EXISTS sales_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL UNIQUE,         -- 飞书消息 id（消息级幂等键，S79-2）
  chat_id TEXT NOT NULL,                   -- 来源销售群（settings.sales.chatId）
  speaker_id TEXT NOT NULL DEFAULT '',     -- 发言人 open_id（回执 @ 与审计）
  text TEXT NOT NULL DEFAULT '',           -- 原文快照（复核/重解析用，D2 保留原话口径）
  ts INTEGER NOT NULL,                     -- 消息时刻 epoch 毫秒（游标 = MAX(秒)）
  status TEXT NOT NULL CHECK (status IN ('recorded', 'pending_fields', 'noise', 'duplicate')),
  detail TEXT NOT NULL DEFAULT '',         -- 状态说明（缺失字段清单等）
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sales_messages_ts ON sales_messages(ts);

CREATE TABLE IF NOT EXISTS sales_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL,                -- 源报单消息（溯源；非唯一——补发合流不建新行）
  order_no TEXT NOT NULL DEFAULT '',       -- 订单号（业务幂等键；空 = 报单未提供）
  deal_day TEXT NOT NULL,                  -- 北京日历日 YYYY-MM-DD（S19，汇总日界口径）
  deal_ts INTEGER NOT NULL,                -- 成交日北京零点 epoch 毫秒（写表格 datetime 用）
  amount REAL NOT NULL,                    -- 成交金额（元；销售域金额对象，K79）
  product TEXT NOT NULL DEFAULT '',        -- 归一后产品名（名册见 engine/salesParser.js）
  assistant TEXT NOT NULL DEFAULT '',      -- 归一后小助手名（剥括号注释）
  customer_nick TEXT NOT NULL DEFAULT '',
  customer_name TEXT NOT NULL DEFAULT '',
  customer_phone TEXT NOT NULL DEFAULT '',
  pay_platform TEXT NOT NULL DEFAULT '',   -- 微信|支付宝|微店|线下|其他（空 = 未提供）
  trade_no TEXT NOT NULL DEFAULT '',       -- 付款账号或平台交易号
  self_owned TEXT NOT NULL DEFAULT '',     -- 是|否（空 = 未提供，不猜）
  distribution TEXT NOT NULL DEFAULT '',   -- 是|否（空 = 未提供，不猜）
  note TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'bot',      -- bot（群报单）| manual（人工录入，预留）
  synced_record_id TEXT,                   -- 多维表格 record_id（NULL = 未同步/失败待补推，S79-6）
  synced_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_records_order ON sales_records(order_no) WHERE order_no != '';
CREATE INDEX IF NOT EXISTS idx_sales_records_day ON sales_records(deal_day);
