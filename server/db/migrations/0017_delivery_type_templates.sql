-- 0017：四类交付项目类型预置 + 停用占位类型（PRD S31 / v0.30）
-- 来源：飞书「闪光新版知识库(建设中)」30_项目与流程 → 31_项目交付流程汇总。蒸馏口径见 PRD §7.13：
--   只收「值得逐条勾选追踪」的管理项（排期确认→交付执行→归档收尾），话术/工具/设备/表单链接等
--   操作细节留在知识库 SOP 不搬运；标题为纯中文动作句，无阶段、无预设依赖（v0.6 扁平模型不变）。
-- 停用三个 v0.1 占位类型（K5 默认种子退役）——「删除=软删」约定：创建入口经 active 过滤不再展示，
--   以其编码立项 400（S17-8 既有校验），历史项目的类型快照（template_code）与外键不受影响，可恢复。
-- 幂等：类型行经 UNIQUE(code) + INSERT OR IGNORE；任务行按类型级 NOT EXISTS 守卫，meta 丢失重放不重复插。
-- 种子时间戳沿用 0002 约定取 0（无真实业务时间）。

INSERT OR IGNORE INTO project_types (code, name, description, status, created_at, updated_at) VALUES
  ('lianmai_365', '365连麦',
   '斯斯确认日期后发起一场线上连麦：排期与用户确认、对接群与预热、双平台直播、归档与状态更新。SOP：闪光新版知识库 31.01_365线上连麦交付流程模板 https://ghy685ffir.feishu.cn/wiki/SvjnwrHndimXMdkK7WPckoWqnQh',
   'active', 0, 0),
  ('consulting_1v1', '1v1商业咨询',
   '客户购买后的1v1咨询交付（线下茶室或线上会议）：预约入库、排期与地点、咨询交付、归档同步。SOP：咨询1V1商业咨询用户预约SOP https://ghy685ffir.feishu.cn/wiki/QxIwwlUj2iSO5sktH3TcQ66znNe 与 31.06_1V1商业咨询标准流程目标',
   'active', 0, 0),
  ('afternoon_tea', '商业下午茶',
   '斯斯行程发起的城市线下场次（0606 含销售环节模板）：招募成交、销售与场地准备、交付日执行、跟进与归档。SOP：31.02_商业下午茶交付流程模板 https://ghy685ffir.feishu.cn/wiki/KBHgwNGgbifXkfk8PiVcPEbhnCS',
   'active', 0, 0),
  ('internal_training', '内训课',
   '面向小私董的嘉宾内训分享：选题与嘉宾对接、大纲审核、宣发、执行与转化、归档复盘。SOP：31.03_小私董内训标准流程 https://ghy685ffir.feishu.cn/wiki/ZK7QwQm67iQGiCkfwv4cwarHnph',
   'active', 0, 0);

INSERT INTO project_type_tasks (type_id, title, sort_order)
SELECT pt.id, x.title, x.sort_order
FROM project_types pt
JOIN (
  SELECT 'lianmai_365' AS code, '创建本场连麦记录并确定主负责人' AS title, 1 AS sort_order UNION ALL
  SELECT 'lianmai_365', '按排队顺序筛选连麦用户并确认到场状态', 2 UNION ALL
  SELECT 'lianmai_365', '收集确认连麦问题并定稿清单排序', 3 UNION ALL
  SELECT 'lianmai_365', '拉用户进连麦对接群并核对微博实名', 4 UNION ALL
  SELECT 'lianmai_365', '制作预热文案并创建微博预约直播', 5 UNION ALL
  SELECT 'lianmai_365', '发布社群预热并完成推流报备', 6 UNION ALL
  SELECT 'lianmai_365', '完成开播前设备预检', 7 UNION ALL
  SELECT 'lianmai_365', '完成现场布置与人员到岗确认', 8 UNION ALL
  SELECT 'lianmai_365', '完成双平台开播准备与开场热场', 9 UNION ALL
  SELECT 'lianmai_365', '按顺序执行连麦与计时换麦', 10 UNION ALL
  SELECT 'lianmai_365', '结束直播并完成现场与群收尾', 11 UNION ALL
  SELECT 'lianmai_365', '下载直播回放并导出麦克风音频', 12 UNION ALL
  SELECT 'lianmai_365', '完成音频粗拼、文稿与素材归档', 13 UNION ALL
  SELECT 'lianmai_365', '更新连麦登记表用户状态', 14 UNION ALL

  SELECT 'consulting_1v1', '确认用户预约与下单并入库', 1 UNION ALL
  SELECT 'consulting_1v1', '完成售前咨询与适合度判断', 2 UNION ALL
  SELECT 'consulting_1v1', '录入下单用户权益明细', 3 UNION ALL
  SELECT 'consulting_1v1', '收集用户咨询问题与期望时段', 4 UNION ALL
  SELECT 'consulting_1v1', '确认咨询排期并上斯斯日历', 5 UNION ALL
  SELECT 'consulting_1v1', '预约线下茶室包厢或创建线上会议链接', 6 UNION ALL
  SELECT 'consulting_1v1', '同步咨询安排给用户并拉对接群', 7 UNION ALL
  SELECT 'consulting_1v1', '整理咨询问题文档提前交斯斯', 8 UNION ALL
  SELECT 'consulting_1v1', '咨询前提醒双方并交代茶室准备', 9 UNION ALL
  SELECT 'consulting_1v1', '执行咨询交付（线下或线上）', 10 UNION ALL
  SELECT 'consulting_1v1', '更新权益明细状态为已交付', 11 UNION ALL
  SELECT 'consulting_1v1', '归档文稿录音与策略报告并同步用户', 12 UNION ALL

  SELECT 'afternoon_tea', '项目启动与数据初始化（确定城市、时间与负责人）', 1 UNION ALL
  SELECT 'afternoon_tea', '通知小助手启动招募', 2 UNION ALL
  SELECT 'afternoon_tea', '预售沟通线索与优先渠道用户', 3 UNION ALL
  SELECT 'afternoon_tea', '朋友圈与小圈子发布招募文案', 4 UNION ALL
  SELECT 'afternoon_tea', '确认成交并录入成交信息', 5 UNION ALL
  SELECT 'afternoon_tea', '收集用户问题表单（付款后24小时内）', 6 UNION ALL
  SELECT 'afternoon_tea', '分析参会名单与话术禁忌（活动前3天）', 7 UNION ALL
  SELECT 'afternoon_tea', '确认价格与收款方式（活动前1天）', 8 UNION ALL
  SELECT 'afternoon_tea', '预订场地晚餐并准备物料设备', 9 UNION ALL
  SELECT 'afternoon_tea', '评估客户发言顺序（AI辅助排序）', 10 UNION ALL
  SELECT 'afternoon_tea', '确认现场人员分工并拉当天工作群', 11 UNION ALL
  SELECT 'afternoon_tea', '发送邀请函并确认化妆与用车安排', 12 UNION ALL
  SELECT 'afternoon_tea', '执行交付日现场安排（布置、拍摄与按序交流）', 13 UNION ALL
  SELECT 'afternoon_tea', '转写用户咨询文稿并实时归档', 14 UNION ALL
  SELECT 'afternoon_tea', '交付后销售跟进（意向用户回访与价格提醒）', 15 UNION ALL
  SELECT 'afternoon_tea', '归档资料、收集用户反馈并核对场次费用', 16 UNION ALL

  SELECT 'internal_training', '盘点用户高频问题并确定选题', 1 UNION ALL
  SELECT 'internal_training', '匹配候选嘉宾并提请斯斯确认', 2 UNION ALL
  SELECT 'internal_training', '完成第一轮嘉宾沟通并建立嘉宾信息卡', 3 UNION ALL
  SELECT 'internal_training', '确定分享主题、大纲与合作条件', 4 UNION ALL
  SELECT 'internal_training', '评估嘉宾产品并确认分润条款', 5 UNION ALL
  SELECT 'internal_training', '完成AI辅助大纲优化', 6 UNION ALL
  SELECT 'internal_training', '提请斯斯审核大纲终稿', 7 UNION ALL
  SELECT 'internal_training', '建有赞购买链接与产品详情页', 8 UNION ALL
  SELECT 'internal_training', '制作宣发素材（嘉宾海报与课程预告）', 9 UNION ALL
  SELECT 'internal_training', '完成群内预告、朋友圈宣发与倒计时提醒', 10 UNION ALL
  SELECT 'internal_training', '完成技术准备（会议链接、录音与嘉宾PPT）', 11 UNION ALL
  SELECT 'internal_training', '主持开场并执行分享、答疑与产品推送', 12 UNION ALL
  SELECT 'internal_training', '完成转化跟进（群讨论、私聊与数据统计）', 13 UNION ALL
  SELECT 'internal_training', '归档资料并完成项目复盘', 14
) x ON x.code = pt.code
WHERE NOT EXISTS (SELECT 1 FROM project_type_tasks t WHERE t.type_id = pt.id);

-- 占位类型停用（软删）：只改状态，不动其任务行与历史引用
UPDATE project_types
SET status = 'disabled', updated_at = 0
WHERE code IN ('software_delivery', 'consulting', 'custom') AND status = 'active';
