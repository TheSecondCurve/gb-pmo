-- S62（v0.67，design.md K47）：知识库默认父页面——项目未绑定时，记录经确认卡在此页下新建子页。
-- 初始值=交付时拍板的默认父页面；管理员可在配置台改（INSERT OR IGNORE 不覆盖既有设置）。
INSERT OR IGNORE INTO settings (key, value, updated_at, updated_by)
VALUES (
  'wiki',
  '{"defaultParentUrl":"https://ghy685ffir.feishu.cn/wiki/RPpBwqXzOiMgSZkEgRCcoSN8nef"}',
  strftime('%s', 'now') * 1000,
  NULL
);
