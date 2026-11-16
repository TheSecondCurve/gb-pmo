-- S78（v0.92，design.md K78）：引用回复上下文透传——im_buffer 增加被引用原文与被引用发言人两列，
-- 网关把引用上下文随未@群消息落缓冲，排干抽取与 fetchMessages API 路径同口径。
ALTER TABLE im_buffer ADD COLUMN quote_text TEXT;
ALTER TABLE im_buffer ADD COLUMN quote_speaker_id TEXT;
