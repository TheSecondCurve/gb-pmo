-- 0033_archive_files.sql — S63 附件归档台账：成功归档文件数与被跳过原因（JSON 数组 [{name, reason}]）
ALTER TABLE wiki_archive_runs ADD COLUMN file_count INTEGER;
ALTER TABLE wiki_archive_runs ADD COLUMN skipped_files TEXT;
