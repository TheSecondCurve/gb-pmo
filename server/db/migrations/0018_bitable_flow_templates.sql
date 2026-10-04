-- 0018：九类业务线项目类型预置（PRD S32 / v0.32）
-- 来源：飞书「项目多维表格」（团队现役项目排期 Base，ghy685ffir.feishu.cn/base/L2npbvswta8yuhsww5TcudF5nQf）
--   ① 「流程模板」表 7 类 59 步（字段：步骤名/负责人/产出物与验收标准/需要斯斯/常见坑（聊天记录实证）/步骤序号）
--   ② 「项目排期」表通用进度轴①-⑬（B端-平台合作无专属步骤，按轴 1:1 蒸馏 13 条）
--   ③ 「项目排期」在跑「内部-系统建设」类目（无步骤沉淀，给通用骨架，立项可自定义）
-- 蒸馏口径沿 S31/0017：只收「值得逐条勾选追踪」的管理项；标题纯中文动作句、无阶段无依赖；
--   产出物融入动宾；「需要斯斯=是」的步骤标题尾部统一缀「（斯斯把关）」（共 22 条）；
--   负责人列不搬运（列值为具体人名，模板不固化具体人，立项后指派）；常见坑精华入类型描述并附源表链接。
-- 与 v0.30 四类交付类型（0017）并存不替换：粒度不同（四类=具体交付产品操作级清单，本批=业务线主干），
--   既有类型与任务零改动（有引用类型移出=停用、须人裁决）。
-- 幂等：类型行经 UNIQUE(code) + INSERT OR IGNORE；任务行按类型级 NOT EXISTS 守卫，meta 丢失重放不重复插。
-- 种子时间戳沿用 0017 约定取 0（无真实业务时间）。

INSERT OR IGNORE INTO project_types (code, name, description, status, created_at, updated_at) VALUES
  ('b2b_ads', 'B端-广告商单',
   'B端广告商单全流程（接Brief→方案报价→脚本→拍摄→粗剪→批改迭代→客户审核→封面定稿→发布回款）。典型坑：QA不闭环就交付、模糊需求要结构化拆解确认；大平台投放修改窗口有限、第一次就要交到位；敏感词在脚本阶段问清，不等审片才发现；版本命名成链（初版→修改N→斯斯修改版→客户审核版→最终版）。来源：飞书「项目多维表格」流程模板 https://ghy685ffir.feishu.cn/base/L2npbvswta8yuhsww5TcudF5nQf?table=tbl1AwhRj4OnZm3D',
   'active', 0, 0),
  ('b2b_consulting', 'B端-咨询陪跑',
   'B端咨询/陪跑交付（线索判断→分阶段方案→签约收款→交付→确认→结算→升单归档）。典型坑：B线索散在C端私聊没人系统盯；对外价格口径只能有一个说法；服务交接人签约时就指定、不临时派；升单靠真实体验不靠谈判技巧；案例入库要脱敏并经本人同意。来源：飞书「项目多维表格」流程模板 https://ghy685ffir.feishu.cn/base/L2npbvswta8yuhsww5TcudF5nQf?table=tbl1AwhRj4OnZm3D',
   'active', 0, 0),
  ('b2b_platform', 'B端-平台合作',
   'B端平台合作（共创内容、黑客松、渠道分成课等）。源表无专属步骤，清单按项目排期表通用进度轴①-⑬逐节点蒸馏（立项/Brief→方案报价→脚本框架→拍摄录制→粗剪初稿→斯斯批改→精修迭代→标题终审→合规/客户审核→待发布→已发布/交付→结算回款→归档），可按项目增删。来源：飞书「项目多维表格」项目排期 https://ghy685ffir.feishu.cn/base/L2npbvswta8yuhsww5TcudF5nQf?table=tbl36PRTAWVaUfM8',
   'active', 0, 0),
  ('content_podcast', '内容-播客',
   '播客内容生产全流程（选题排期→录制→粗剪→斯斯重排批改→修改迭代→修音精剪→标题Shownotes→斯斯终审→发布→三层宣发→数据归档）。典型坑：排期不进表=老板三不知；视频算力投入产出低、先纯音频数据好再切条；起标题是脑力活、标题质量是该环节唯一KPI；终审提前约时间、临时弹窗绝对不接；数据不回流=白干。来源：飞书「项目多维表格」流程模板 https://ghy685ffir.feishu.cn/base/L2npbvswta8yuhsww5TcudF5nQf?table=tbl1AwhRj4OnZm3D',
   'active', 0, 0),
  ('content_video', '内容-视频口播',
   '视频口播内容生产（脚本→拍摄准备→口播拍摄→空镜拍摄→剪辑→斯斯批改→修改迭代→封面标题→发布归档）。典型坑：空镜比人重要、按最高标准一次拍对没有多次重拍；棚提前一天收拾、站位提前踩点；AI初稿要按本人语气逐句过稿；花字信息彼此呼应而非复述口播。来源：飞书「项目多维表格」流程模板 https://ghy685ffir.feishu.cn/base/L2npbvswta8yuhsww5TcudF5nQf?table=tbl1AwhRj4OnZm3D',
   'active', 0, 0),
  ('c2c_launch', 'C端-产品发售',
   'C端产品发售战役（资格条件→定开售日→预热浪→开售→收口浪→战报→定价拍板→复盘→数据归档）。典型坑：条件不齐不硬开、备案滑档提前48小时通报；老板只出场两次且要排进表、不接受临时加；异议原文逐条收、是下轮定价的弹药；销售日报没数字=没有销售线。来源：飞书「项目多维表格」流程模板 https://ghy685ffir.feishu.cn/base/L2npbvswta8yuhsww5TcudF5nQf?table=tbl1AwhRj4OnZm3D',
   'active', 0, 0),
  ('c2c_event', 'C端-活动',
   'C端线下城市场次通用流程（立项→招募统筹→物料场地→执行→交付体验→复盘归档），适用于1v1咨询、下午茶、内训、股东小会等。典型坑：每月开几场必须有人拍板；漏斗数每周进周复盘；场地布置提前一天完成并踩点；体验反馈报告是B端客户要的东西。来源：飞书「项目多维表格」流程模板 https://ghy685ffir.feishu.cn/base/L2npbvswta8yuhsww5TcudF5nQf?table=tbl1AwhRj4OnZm3D',
   'active', 0, 0),
  ('c2b_cross', '横跨C→B',
   'C端用户露出B端需求后的跨线交接（识别需求→指定唯一owner→交接单→B端流程接管→交付→分账结算）。典型坑：owner不指定=两头管或两头不管；交接只认项目群交接单、口头不算；接管后不再走C端节奏；先跑通服务链路再谈分账。来源：飞书「项目多维表格」流程模板 https://ghy685ffir.feishu.cn/base/L2npbvswta8yuhsww5TcudF5nQf?table=tbl1AwhRj4OnZm3D',
   'active', 0, 0),
  ('internal_build', '内部-系统建设',
   '内部工具与系统建设项目通用骨架（目标对齐→方案起草→评审拍板→开发执行→验收上线归档复盘）。源表无步骤沉淀，立项时按项目自由增删改。来源：飞书「项目多维表格」项目排期（内部-系统建设类目） https://ghy685ffir.feishu.cn/base/L2npbvswta8yuhsww5TcudF5nQf?table=tbl36PRTAWVaUfM8',
   'active', 0, 0);

INSERT INTO project_type_tasks (type_id, title, sort_order)
SELECT pt.id, x.title, x.sort_order
FROM project_types pt
JOIN (
  -- B端-广告商单（源表 11 步；斯斯把关：方案报价/脚本/批改/封面标题）
  SELECT 'b2b_ads' AS code, '接收Brief并完成需求十问核对与资料通读' AS title, 1 AS sort_order UNION ALL
  SELECT 'b2b_ads', '确定打法、报价与修改窗口约定（斯斯把关）', 2 UNION ALL
  SELECT 'b2b_ads', '完成脚本创作与修改定稿（斯斯把关）', 3 UNION ALL
  SELECT 'b2b_ads', '完成口播与空镜拍摄并当场拦素材瑕疵', 4 UNION ALL
  SELECT 'b2b_ads', '完成深度素材拍摄并当日整理归位', 5 UNION ALL
  SELECT 'b2b_ads', '完成初版成片粗剪', 6 UNION ALL
  SELECT 'b2b_ads', '完成逐段批注批改并单独成档（斯斯把关）', 7 UNION ALL
  SELECT 'b2b_ads', '按批注完成修改迭代并守版本命名链', 8 UNION ALL
  SELECT 'b2b_ads', '推进客户审核并预留审批缓冲', 9 UNION ALL
  SELECT 'b2b_ads', '完成封面与标题多版定稿（斯斯把关）', 10 UNION ALL
  SELECT 'b2b_ads', '完成定档发布、互动钩子与打包回款闭环', 11 UNION ALL

  -- B端-咨询陪跑（源表 7 步；斯斯把关：线索判断/方案报价/升单归档）
  SELECT 'b2b_consulting', '识别并判断B端线索是否接单（斯斯把关）', 1 UNION ALL
  SELECT 'b2b_consulting', '制定分阶段方案并统一对外价格口径（斯斯把关）', 2 UNION ALL
  SELECT 'b2b_consulting', '签约并写定收款节奏与抵扣规则', 3 UNION ALL
  SELECT 'b2b_consulting', '指定唯一owner并按承诺完成服务交付', 4 UNION ALL
  SELECT 'b2b_consulting', '收集客户阶段确认与体验反馈', 5 UNION ALL
  SELECT 'b2b_consulting', '完成尾款与分成结算', 6 UNION ALL
  SELECT 'b2b_consulting', '完成升单推进或脱敏案例归档（斯斯把关）', 7 UNION ALL

  -- B端-平台合作（排期表通用进度轴①-⑬逐节点，源表无专属步骤）
  SELECT 'b2b_platform', '完成立项与Brief确认', 1 UNION ALL
  SELECT 'b2b_platform', '完成方案与报价确认', 2 UNION ALL
  SELECT 'b2b_platform', '完成脚本或框架定稿', 3 UNION ALL
  SELECT 'b2b_platform', '完成拍摄或录制执行', 4 UNION ALL
  SELECT 'b2b_platform', '完成粗剪或初稿', 5 UNION ALL
  SELECT 'b2b_platform', '完成斯斯批改', 6 UNION ALL
  SELECT 'b2b_platform', '完成精修与修改迭代', 7 UNION ALL
  SELECT 'b2b_platform', '完成标题与封面终审', 8 UNION ALL
  SELECT 'b2b_platform', '完成合规或客户审核', 9 UNION ALL
  SELECT 'b2b_platform', '完成发布前准备与定档', 10 UNION ALL
  SELECT 'b2b_platform', '完成发布或交付', 11 UNION ALL
  SELECT 'b2b_platform', '完成结算回款', 12 UNION ALL
  SELECT 'b2b_platform', '完成结案归档', 13 UNION ALL

  -- 内容-播客（源表 11 步；斯斯把关：重排批改/终审）
  SELECT 'content_podcast', '确定选题并进排期表锁定档期', 1 UNION ALL
  SELECT 'content_podcast', '完成录制并确定音视频形态', 2 UNION ALL
  SELECT 'content_podcast', '完成粗剪与全文本', 3 UNION ALL
  SELECT 'content_podcast', '完成顺序重排与批注批改（斯斯把关）', 4 UNION ALL
  SELECT 'content_podcast', '按批改完成修改迭代并限定往返轮次', 5 UNION ALL
  SELECT 'content_podcast', '完成修音与精剪', 6 UNION ALL
  SELECT 'content_podcast', '完成标题与Shownotes制作', 7 UNION ALL
  SELECT 'content_podcast', '完成标题与开头音乐终审（斯斯把关）', 8 UNION ALL
  SELECT 'content_podcast', '定档并发布到各平台', 9 UNION ALL
  SELECT 'content_podcast', '完成朋友圈、小红书、视频号三层宣发', 10 UNION ALL
  SELECT 'content_podcast', '归档播放数据与用户反馈并回流选题', 11 UNION ALL

  -- 内容-视频口播（源表 9 步；斯斯把关：脚本/口播拍摄/批改/封面标题）
  SELECT 'content_video', '完成口播脚本并按语气逐句过稿（斯斯把关）', 1 UNION ALL
  SELECT 'content_video', '完成棚地布置、设备与站位踩点', 2 UNION ALL
  SELECT 'content_video', '完成口播拍摄与开头补录（斯斯把关）', 3 UNION ALL
  SELECT 'content_video', '按清单拍全空镜', 4 UNION ALL
  SELECT 'content_video', '完成剪辑成片与音乐节奏', 5 UNION ALL
  SELECT 'content_video', '完成逐段标注批改（斯斯把关）', 6 UNION ALL
  SELECT 'content_video', '完成修改迭代至定稿', 7 UNION ALL
  SELECT 'content_video', '完成封面与标题定稿（斯斯把关）', 8 UNION ALL
  SELECT 'content_video', '完成发布与数据回流归档', 9 UNION ALL

  -- C端-产品发售（源表 9 步；斯斯把关：资格条件/预热浪/定价拍板）
  SELECT 'c2c_launch', '核验发售资格条件与备案状态（斯斯把关）', 1 UNION ALL
  SELECT 'c2c_launch', '条件齐备后确定开售日', 2 UNION ALL
  SELECT 'c2c_launch', '执行预热浪并锁定斯斯出场场次（斯斯把关）', 3 UNION ALL
  SELECT 'c2c_launch', '完成开售并当天录入订单日报', 4 UNION ALL
  SELECT 'c2c_launch', '执行收口浪并逐条回收异议原文', 5 UNION ALL
  SELECT 'c2c_launch', '每浪结束当天产出六项战报', 6 UNION ALL
  SELECT 'c2c_launch', '以真实转化数据拍板定价（斯斯把关）', 7 UNION ALL
  SELECT 'c2c_launch', '完成当月复盘', 8 UNION ALL
  SELECT 'c2c_launch', '归档全量数据档案', 9 UNION ALL

  -- C端-活动（源表 6 步；斯斯把关：立项/执行）
  SELECT 'c2c_event', '拍板是否立项与档期（斯斯把关）', 1 UNION ALL
  SELECT 'c2c_event', '统筹招募并跟踪触达成交漏斗', 2 UNION ALL
  SELECT 'c2c_event', '完成物料与场地准备', 3 UNION ALL
  SELECT 'c2c_event', '执行活动现场并提前锁定斯斯到场（斯斯把关）', 4 UNION ALL
  SELECT 'c2c_event', '收集用户体验并产出反馈报告', 5 UNION ALL
  SELECT 'c2c_event', '完成转化复盘与案例入库', 6 UNION ALL

  -- 横跨C→B（源表 6 步；斯斯把关：识别需求/指定owner/交付/分账）
  SELECT 'c2b_cross', '识别并标记C端用户露出的B需求（斯斯把关）', 1 UNION ALL
  SELECT 'c2b_cross', '指定一跟到底的唯一owner（斯斯把关）', 2 UNION ALL
  SELECT 'c2b_cross', '在项目群发出交接单（现状、承诺与下一步）', 3 UNION ALL
  SELECT 'c2b_cross', '切换B端流程接管服务', 4 UNION ALL
  SELECT 'c2b_cross', '按B端流程完成服务交付（斯斯把关）', 5 UNION ALL
  SELECT 'c2b_cross', '跑通服务链路后议定分账结算（斯斯把关）', 6 UNION ALL

  -- 内部-系统建设（源表无步骤沉淀，通用骨架，立项可自定义）
  SELECT 'internal_build', '立项并对齐目标与范围', 1 UNION ALL
  SELECT 'internal_build', '完成方案或计划起草', 2 UNION ALL
  SELECT 'internal_build', '组织相关方评审并拍板', 3 UNION ALL
  SELECT 'internal_build', '完成开发或执行', 4 UNION ALL
  SELECT 'internal_build', '完成验收上线并归档复盘', 5
) x ON x.code = pt.code
WHERE NOT EXISTS (SELECT 1 FROM project_type_tasks t WHERE t.type_id = pt.id);
