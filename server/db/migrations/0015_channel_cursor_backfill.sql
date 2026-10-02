-- S3-6（v0.24）渠道绑定统一「不回灌历史」：新建绑定 cursor=绑定时刻（upsertChannel 落值）。
-- 存量空游标渠道（旧版 web/Agent 建的，首拉会回看 7 天）按升级时刻回填，不回灌历史；
-- 回看历史的唯一途径是管理员 reset_channel_cursor（1~90 天，S17-10）。
-- strftime('%s','now') 为 epoch 秒（时区无关），与游标既有存储口径一致。
UPDATE channels SET cursor = CAST(strftime('%s', 'now') AS TEXT) WHERE cursor IS NULL OR cursor = '';
