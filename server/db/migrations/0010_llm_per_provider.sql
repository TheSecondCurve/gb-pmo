-- S17-11（v0.15）：LLM 配置按类别分开存储。存量扁平行（顶层 apiKey/baseUrl/model，v0.14 及更早）
-- 迁移为嵌套结构：老 apiKey/baseUrl/model 搬进当时生效类别的子配置（provider 缺省按 deepseek），
-- 另一类别子配置置默认（空 key）；timeoutMs 全局保留。已迁移行（含 $.deepseek）不动，幂等。
UPDATE settings SET value = json_object(
    'provider', COALESCE(json_extract(value, '$.provider'), 'deepseek'),
    'deepseek', json_object(
        'apiKey', CASE WHEN COALESCE(json_extract(value, '$.provider'), 'deepseek') = 'deepseek'
                      THEN COALESCE(json_extract(value, '$.apiKey'), '') ELSE '' END,
        'baseUrl', CASE WHEN COALESCE(json_extract(value, '$.provider'), 'deepseek') = 'deepseek'
                        THEN COALESCE(json_extract(value, '$.baseUrl'), 'https://api.deepseek.com')
                        ELSE 'https://api.deepseek.com' END,
        'model', CASE WHEN COALESCE(json_extract(value, '$.provider'), 'deepseek') = 'deepseek'
                      THEN COALESCE(json_extract(value, '$.model'), 'deepseek-chat') ELSE 'deepseek-chat' END),
    'glm-coding', json_object(
        'apiKey', CASE WHEN json_extract(value, '$.provider') = 'glm-coding'
                      THEN COALESCE(json_extract(value, '$.apiKey'), '') ELSE '' END,
        'baseUrl', CASE WHEN json_extract(value, '$.provider') = 'glm-coding'
                        THEN COALESCE(json_extract(value, '$.baseUrl'), 'https://open.bigmodel.cn/api/coding/paas/v4')
                        ELSE 'https://open.bigmodel.cn/api/coding/paas/v4' END,
        'model', CASE WHEN json_extract(value, '$.provider') = 'glm-coding'
                      THEN COALESCE(json_extract(value, '$.model'), 'glm-5.3') ELSE 'glm-5.3' END),
    'timeoutMs', COALESCE(json_extract(value, '$.timeoutMs'), 60000))
WHERE key = 'llm' AND json_type(value, '$.deepseek') IS NULL;
