-- 0043_sales_ops.sql — S81（v0.95，design.md K81）：销售运营动作域
-- 三张新表 + sales_messages 重建（status 枚举扩展 ops_report/ops_lead）。
--
-- sales_assistants：外部小助手名册（不进 members——外部人员不占内部身份脊柱/权限面）。
--   open_id 唯一；assistant_name=规范名（初值=群昵称，用户配置台改）；共现学习 candidate→confirmed。
-- ops_reports：日终汇总，幂等键 (account, day)——重发=修订覆盖（revision 计数）。
--   reported_amount 是人工汇总口径，仅对账（与 sales_records 零写路径交集，K81 红线）。
-- ops_leads：线索两源一去处（scatter=零散上报 / digest=日终汇总区块），(account, wechat_id)
--   部分唯一索引去重；无微信号组合查重在引擎层。

CREATE TABLE IF NOT EXISTS sales_assistants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assistant_name TEXT NOT NULL,              -- 名册规范名（漫漫/光光…；初值=群昵称，配置台可改）
  open_id TEXT NOT NULL UNIQUE,              -- 飞书用户（外部群成员，全局唯一稳定）
  display_name TEXT NOT NULL DEFAULT '',     -- 群昵称/显示名（初始化灌入，人工核对辅助）
  status TEXT NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate', 'confirmed')),
  bound_at INTEGER,                          -- confirmed 时刻
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ops_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL,                  -- 最新修订的源消息（历史修订在 sales_messages 台账）
  speaker_id TEXT NOT NULL DEFAULT '',       -- 最新修订发言人 open_id（换人代报检测）
  account TEXT NOT NULL,                     -- 名册规范名
  day TEXT NOT NULL,                         -- 北京日历日（S19）
  reported_amount REAL,                      -- 日报口径当日销售额——仅对账，绝不进成交统计
  products TEXT NOT NULL DEFAULT '',
  new_friends INTEGER,                       -- 新增好友
  active_reach INTEGER,                      -- 主动触达用户
  passive_reach INTEGER,                     -- 被动触达用户
  moments_count INTEGER,                     -- 朋友圈数量
  passive_interact INTEGER,                  -- 被点赞评论互动
  active_interact INTEGER,                   -- 主动点赞评论互动
  raw_summary TEXT NOT NULL DEFAULT '',      -- 原文摘要（兜住未预期内容）
  revision INTEGER NOT NULL DEFAULT 1,       -- 修订次数（重发=修正覆盖）
  synced_record_id TEXT,                     -- 多维表格行（修订后置空待 upsert）
  synced_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(account, day)
);
CREATE INDEX IF NOT EXISTS idx_ops_reports_day ON ops_reports(day);

CREATE TABLE IF NOT EXISTS ops_leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL,
  account TEXT NOT NULL DEFAULT '',          -- 归属账号（文本自带或发言人名册反查）
  day TEXT NOT NULL,                         -- 北京日历日
  wechat_name TEXT NOT NULL DEFAULT '',
  wechat_id TEXT NOT NULL DEFAULT '',
  intent_product TEXT NOT NULL DEFAULT '',
  source_channel TEXT NOT NULL DEFAULT '',
  lead_source TEXT NOT NULL DEFAULT 'scatter' CHECK (lead_source IN ('scatter', 'digest')),
  raw_text TEXT NOT NULL DEFAULT '',
  synced_record_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ops_leads_dedupe ON ops_leads(account, wechat_id) WHERE wechat_id != '';
CREATE INDEX IF NOT EXISTS idx_ops_leads_day ON ops_leads(day);

-- sales_messages 重建：status 枚举扩 ops_report / ops_lead（SQLite CHECK 不可改，标准重建法；
-- 现表数据量小，重建无风险；索引随建）。
CREATE TABLE IF NOT EXISTS sales_messages_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL UNIQUE,
  chat_id TEXT NOT NULL,
  speaker_id TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  ts INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('recorded', 'pending_fields', 'noise', 'duplicate', 'ops_report', 'ops_lead')),
  detail TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
INSERT INTO sales_messages_v2 (message_id, chat_id, speaker_id, text, ts, status, detail, created_at)
  SELECT message_id, chat_id, speaker_id, text, ts, status, detail, created_at FROM sales_messages;
DROP TABLE sales_messages;
ALTER TABLE sales_messages_v2 RENAME TO sales_messages;
CREATE INDEX IF NOT EXISTS idx_sales_messages_ts ON sales_messages(ts);
