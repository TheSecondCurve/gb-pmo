# 决策日志（gb-pmo / 企业项目大脑）

> 格式见 engineering-standards.md §7：每条记 **决策 / 理由 / 推翻了什么旧决定**。编号只增不改。

## K1 密码哈希用 scrypt 替代 argon2id

- 决策：密码哈希使用 node:crypto `scrypt`（N=16384, r=8, p=1，随机 salt），不引入 argon2 原生模块。
- 理由：better-sqlite3 已是本项目唯一原生编译依赖，再叠 argon2 增加安装失败面；scrypt 是内置且强度合格的 KDF。
- 推翻：tech-architecture.md 默认「密码 argon2id」。已在该标准副本标注。

## K2 不引入 ORM，查询层直用 better-sqlite3 prepared statements

- 决策：表结构以 `server/db/migrations/*.sql` 手写维护，启动时按序执行并记录 `migrations_meta`；查询层不引入 Drizzle，直接使用 better-sqlite3 prepared statements，行级 snake_case → camelCase 映射由 `server/db/index.mjs` 统一处理。
- 理由：本产品的 Agent 接口本身就是 SQL（单一 SQL 端点 + SKILL.md 文档化表结构），引擎层与 Agent 层保持同一数据语言，避免 schema 双轨漂移；单进程小库下 ORM 抽象收益有限；少一个依赖链。
- 推翻：tech-architecture.md 默认「ORM = Drizzle」。已在标准副本标注为偏离。

## K3 新增受限 action 端点（Agent 触发）

- 决策：`POST /api/v1/agent/actions`，动作白名单枚举：`trigger_extraction` / `generate_project_digest` / `generate_person_digest` / `push_report`；PAT write scope + 功能角色校验 + 审计。
- 理由：定时/生成类操作的触发不是数据读写，SQL 端点无法表达（PRD D4 用户拍板「SQL + REST，SKILL 里约定好」）。
- 推翻：agent-integration.md「单一 SQL 端点，不做 Agent 专用 REST」。已在标准副本与 PRD 7.3#4 标注。

## K4 「成本收入」指标域不采用

- 决策：指标体系只保留「业务」「经营有效性」两域。
- 理由：本项目无金额对象（PRD 用户指令裁剪）。
- 推翻：analytics-design.md 三维度域框架中的成本收入域。对应 PRD 7.3#1。

## K5 PRD 未定项按默认值开工

- 决策：PRD v0.4 待确认 #1-#9 未获老板答复前，按以下默认值实施（均为配置台可调或模板可替换，不锁死）：
  - #1 P0 模板：预置「软件交付」「咨询服务」两套 + 自由创建兜底；
  - #2 立项口径：同客户二期默认新立项（结项时可注明延续关系）；
  - #3 优先级档位：管理员与牵头人可改，无固定校准周期；
  - #5 历史回溯：近 30 天（S9 P1 实现）；
  - #7 日报：默认 18:00，接收人为全部在职成员（角色分视角）；
  - #8 阈值默认：沉默 7 天、关键人并行上限 3、采纳率告警线 70%、建议超时 48h、通用群分拣置信度 0.6、健康度红黄绿（沉默≥7 天或逾期≥3 = 红；沉默≥3 天或逾期≥1 = 黄）；
  - #9 维保期业务：不做。
  - #6 部署/工期/预算：不阻塞开发（模式 A 已定）。
- 理由：用户指令「开工这个项目……直到全部完成」；以上项均为可配置参数或可后补决策，不构成架构分叉。
- 推翻：无。后续老板拍板若与默认值冲突，走「先改 PRD → 再改测试（红）→ 再改实现（绿）」。

## K6 企微会话存档拉取器为适配接口，真实拉取依赖官方 C SDK 部署

- 决策：`server/brain/connectors/wecom.js` 实现配置、游标与解密编排骨架，实际拉取在未部署官方 SDK 时返回明确的 CONFIG 错误并附操作指引（PRD 附录 A.2）；飞书连接器为完整实现（REST 拉取）。
- 理由：企微会话存档需付费开通 + 官方 C SDK（Linux），无凭证环境无法联调；接口先行、测试用 ingest 通道覆盖全部分拣/抽取逻辑。
- 推翻：无（S3 的企微侧可用性依赖部署侧动作，PRD 待确认 #4 已记录为预算项）。

## K7 测试主力层与覆盖口径

- 决策：用户视角场景测试走 fastify `inject`（真实路由栈，不 listen）+ 每测试文件独立临时 SQLite 库；覆盖率 v8 核心目录 = `server/engine`、`server/routes`、`server/brain`、`server/agent` ≥80%；前端组件测试按 engineering-standards §3 不设标准层，仅保留构建校验与 2 个冒烟测试。
- 理由：对齐「一种主力测试」与 gb-crm 实践；前端测试弱化是标准明文允许的裁剪。
- 推翻：无（覆盖率仅作用于核心目录，纯声明/入口文件排除在 vitest 配置注明）。

## K8 前端不设 i18n 层

- 决策：SPA 不引入 `i18n.ts` 字典层，界面文案直接中文。
- 理由：内网单语工具型系统，无多语言需求；省一层间接。其余前端规范（手写极简组件、hash 路由、Context store、就地编辑、Toast、设置页即控制台）全部遵守。
- 推翻：tech-architecture.md 前端工程规范表中的「国际化」行。

## K9 机器人指令通道：读自由写收敛 + 事件长连接（S20，v0.11）

- 决策：同一飞书自建应用开通机器人能力，事件订阅用**长连接**（纯出站 wss）收私聊/群@/卡片回调，不新增公网入口、不新增服务，网关随单进程内嵌（`@larksuiteoapi/node-sdk` 懒加载，未安装时明确报错不阻塞主进程）。bot agent = **有界循环**（≤6 轮 LLM / ≤8 次查询）+ 两个半工具：`query`（只读 SQL，护栏与 Agent SQL 端点同源共享，抽为 `server/agent/sqlGuard.js`）、`metric`（queryMetric 口径捷径）、`write`（语义化提议，分发器定性：record 自动生效 / suggest+bind 出确认卡 / trigger 复用 action 白名单注册表，注册表抽为 `server/agent/actions.js` 供 HTTP 端点与 bot 共用）。写路径唯一不变量保持：确认卡点按人限责任人/牵头人/admin，生效走既有 `confirmEvent`（decided_by=点按人）。身份门禁只认 `members.feishu_id`（绑定码仅私聊、凭据不经 LLM）；外部群拒答为安全不变量；`bot_commands` 全审计 + 与定时抽取按 message_id 去重。
- 理由：内网单进程无公网回调面，长连接是唯一零新增部署面；D1 全员透明使读侧零权限面、只读护栏复用即可放开；确认卡使 LLM 写侧错误无害（人核对解析值后才生效）；固定意图目录方案被否决——schema 内省让新信息结构零新增工具即可查（通用、不复杂、自由度高）。
- 推翻：PRD §7.2 推送通道「只发不收」的「不收」——机器人指令通道为双向（推送语义不变，已注记）；「两段式 ≤2 次 LLM 调用」的早期设计约束放宽为有界循环（读侧放开，写侧不变）。

## K10 交付日期复用 plan_end_date + 飞书日历对账式同步（S21/S22，v0.12）

- 决策：**交付日期不新增列**——复用 `projects.plan_end_date` 语义升格（切「进行中」必填、进行中/已暂停不可清空），派生「剩余/超期天数」由引擎统一计算（北京日历日）；飞书项目日历走**对账式同步**：应用身份建一个组织级日历（组织内可搜索订阅），调度任务（`calendarSyncCron`，默认 30 分钟）每轮全量算期望事件内容与 `calendar_sync` 映射表按内容 hash 比对增量 create/patch，**结项/取消项目事件保留不删**（标题加终态前缀、日期定格实际周期；2026-09-30 用户拍板）。
- 理由：新增 `delivery_date` 会与 `plan_end_date` 形成两套「结束日」语义，复用列零迁移零歧义；对账式（非事件驱动埋点）使改期/结项/历史失败下一轮自动收敛，不必在每条路由埋钩子，且天然幂等可测；事件保留使日历成为项目史而非仅当下盘子，与 append-only 讨论面同哲学；内网部署下日历写为纯出站（与拉消息同向），ICS 订阅链接需公网回源不可行。
- 推翻：无（新增能力；`dueTasks` 增加「cronKey 缺失视为未排期」防御，语义对完整配置不变）。

## K11 任务模板并入项目类型 + 立项自定义任务 + 均分倒排（S1/S17/S25，v0.18）

- 决策：**裁撤「任务模板」独立对象**（推翻 v0.5 的类型/模板两对象模型）——项目类型内嵌任务清单（`project_type_tasks`：标题+顺序，v0.6 扁平模型不变），配置台只维护类型一个对象；`projects.template_code` 保留为立项时所选类型编码的快照（历史事实不回改），`createProject` 的 `templateCode` 入参降级为 `typeCode` 的兼容别名（同码解析）。**立项可自定义任务**：`createProject` 接受可选 `tasks`（标题数组），给出即覆盖类型清单实例化（source=manual，允许空清单）；立项弹窗选类型=客户端预填、脏了才提交 `tasks`。**倒排**：`autoSchedule` 开关 + 交付日期 → engine 纯函数按「计划开始（缺省今天，北京日）→ 交付日期」均分填每条任务计划起止（末条=交付日期，开始=上一条截止+1 且钳到自身截止），web 弹窗与 AI 立项提议共用；S25 kind 收敛为四类（模板两类裁撤）、Agent action `create_template` 移除、`draft_template_tasks` 更名 `draft_task_list` 并放开到成员 write scope（立项弹窗起草需要）。
- 理由：v0.6 把模板砍成纯标题列表后，模板对象只剩「几行字符串」的信息量，一个字段不值得一张表+一套 CRUD+一条提议通道；v0.5 拆分所服务的「多类型共用模板」在种子数据里就是 1:1、从未被用，而 AI 起草（S17-9）让复制/重生成一份清单的成本≈0。立项自定义任务与倒排是用户 2026-10-01 拍板：类型清单从「刚性实例化」降格为「预填草稿」更诚实；倒排的日期算术放 engine 确定性完成（LLM 不做算术），且只发生在立项瞬间、随表单/提议整体经人确认——不触碰「不做自动重排期求解器」的负面清单边界。
- 推翻：v0.5「项目类型与任务模板拆分为两个对象（一类型绑定一默认模板，多类型可共用）」；v0.8/v0.9 中模板编辑器/`create_template`/`draft_template_tasks` 的「仅管理员」起草边界（随立项弹窗全员起草放开，配置台页面本身仍仅管理员可进）。

## K12 会话管线统一：一个管线 + 两个薄适配器（S20/S24，v0.25）

- 决策：飞书机器人与 web AI 助手的编排层收敛为**统一会话管线**（`server/brain/bot/pipeline.js`：斜杠命令注册表〔按 surface 声明可用性〕/ 每日限额 / LLM 解析 / 有界循环 / 出口归一化——管线只返回结构化结果不投递），两个入口退化为薄适配器：飞书侧保留幂等去重、外部群拒答、`feishu_id` 身份映射、未绑定门禁、渠道上下文、卡片构造与投递、bot_reply 回执；web 侧保留会话持久化、消息落库、页面确认渲染。管线信封 `{ surface, platform, chatId, chatType, member, channel?, text, ts }` 承载两入口的全部差异（web 恒有身份、群上下文仅 IM 群聊），与「私聊 bot ≈ web 会话」的语义对齐。随管线统一修三处漂移：①限额口径对称（IM 面只计 `platform != 'web'`，web 面只计 `platform='web'`——此前飞书限额把 web 消息也计入）；②web 引入 `/help` `/new` 确定性斜杠命令（进 LLM 之前、零 LLM 成本，LLM 未配置/额度耗尽可用），`/new` 复用 `bot_context_resets` 水位线（platform='web'、chat_id=会话 id），web 历史装配按消息 `created_at` > 水位线过滤；③`/bind` 仍仅飞书私聊（凭据纪律不变）。
- 理由：两入口编排层约 150 行近似复制（`execTool` 闭包逐字重复），漂移已实际发生（限额口径是接近 bug 的不一致）；「丰富交互」前不收拢管线，每个新命令/新卡片都要写两遍且漂移只增不减。`handleBotEvent`/`sendChatMessage` 对外签名不变（s20 测试 41 处直调、s24 走 HTTP inject，测试契约零改动）；后续新交互能力（命令/卡片/推送）只注册一处、两个入口同时生效。
- 推翻：无核心决策被推翻；v0.11「限额=每成员每日指令数」的隐含口径（不区分入口）细化为按面分计，`chat.quotaPerDay` 与 `im.feishu.commandQuotaPerDay` 语义不变、互不串账。
## K13 需求追踪门禁升级到子验收标准粒度

- 决策：check-scenarios.mjs 三层比对——①PRD 顶层 P0 场景（S\d+）在测试文本中；②scenarios.md 登记的逐条子验收标准（S1-1 粒度，含「已废弃」保留编号）在测试文本中（server/test + src 测试都扫）；③PRD 场景与 scenarios.md 章节互为镜像。升级当天即抓到两处断锚（S1-9 缺锚、S4-6 未挂）并修复。
- 理由：原门禁只查顶层编号且只扫 server/test，子条目靠 scenarios.md 手工自觉——大规模扩展时新子条目会悄悄漏测而 CI 不红。
- 推翻：无（门禁加严，旧语义保留为第①层）。

## K14 e2e 层落地：Playwright 业务旅程，独立 workflow 不挡合并

- 决策：新建 e2e/（Playwright + 真 build + 生产形态单进程 + 专用临时库 data/e2e.db 每跑重置）：7 条业务旅程（登录看板/立项/组合页四视图/建议确认闭环/结项/配置台权限/AI 助手降级与斜杠），锚 S1/S5/S8/S17/S24/S30。`.github/workflows/e2e.yml` 独立于 CI（PR/push(main)/每日/手动触发），非必需检查项不挡合并；失败上传 playwright-report。落地过程本身即价值证明：抓了 1 个应用壳品牌文案重名、1 个视图 tab 与导航「全局看板」选择器碰撞、1 个交付日期未填导致时间线空态的测试盲区。
- 理由：前端 3.5k 行此前只有 jsdom 冒烟，S30 这类纯前端特性没有真实渲染回归保障；standards §3 的「Playwright 冒烟」从未落地。
- 推翻：K7「前端仅保留构建校验与 2 个冒烟测试」的裁剪——组件层仍不设标准层（§3 不变），e2e 旅程层补上。

## K15 lint 进 CI：eslint 推荐集 + react-hooks（set-state-in-effect 关闭、exhaustive-deps 降级 warn）

- 决策：eslint flat config（js.recommended + tseslint.recommended + react-hooks）；`react-hooks/set-state-in-effect` 关闭（与手写 Context store「useEffect 里 void refresh()」数据加载惯用法冲突），`exhaustive-deps` 降为 warn（6 处存量待逐个裁决）；`no-control-regex` 仅在两处纯 ASCII 校验测试用 eslint-disable-line 带理由放行。落地即收益：清掉 65 处无用转义（scripts.mjs shell 模板，渲染产物逐字节 diff 验证不变）、6 处死赋值、20+ 未用导入/变量；顺手修复 Chat.tsx 三元表达式语句。standards §5 的 `lint → typecheck → …` 顺序从此名副其实。
- 理由：standards §5 写了 lint 但仓库没有 lint 脚本——标准与实现脱节。
- 推翻：无。

## K16 测试代码同样受 S19 北京时区规则约束

- 决策：测试里算「今天/明天」一律走 `server/db/time.js`（today()/addDays()），禁止裸 `new Date().toISOString().slice(0,10)`。修复 branch-boost/s5-metrics/s6-s7-brain 三处 UTC 反解（北京 00:00–08:00 窗口必炸，本次拆分联调在北京零点窗口实测命中一次 branch-boost 日报用例红）。
- 理由：实现侧时区纪律再严，测试侧用 UTC 语义造数据 = 定时炸弹；CI 设了 TZ=Asia/Shanghai 只能盖住 CI，盖不住其他时区的开发机。
- 推翻：无（AGENTS.md 编码约定条款的测试侧延伸）。

