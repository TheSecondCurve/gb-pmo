-- 0042_sales_vouchers.sql — S80（v0.94.1，design.md K80）：销售报单凭证截图归档
-- 文件实体存飞书云端（bitable 附件），SQLite 只存引用（不落图片二进制，用户拍板）：
--   vouchers       = [{msgId, imageKey}] 源图片消息与 image_key（下载回溯用；JSON 数组，多条=多图）
--   voucher_tokens = 与 vouchers 等长的 file_token 数组（对位记账；null=该图尚未上传成功，
--                    下轮补传——token 幂等：已上传不重传）
-- 图片消息不落 sales_messages 台账（CHECK 枚举不动表；归属幂等靠 vouchers 源消息号查重）。

ALTER TABLE sales_records ADD COLUMN vouchers TEXT NOT NULL DEFAULT '[]';
ALTER TABLE sales_records ADD COLUMN voucher_tokens TEXT NOT NULL DEFAULT '[]';
