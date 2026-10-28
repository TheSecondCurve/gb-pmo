-- S70（v0.82，K66）：快速立项默认类型 = custom（自由创建，空项目锚点）。
-- 0017 曾把旧占位类型（含 custom）软删停用；快速立项需要开箱即用的兜底类型，
-- 重新启用 custom（生产环境用户已手动启用同名类型，此迁移对齐口径；幂等，不动任务清单）。
UPDATE project_types
SET status = 'active', updated_at = strftime('%s', 'now') * 1000
WHERE code = 'custom';
