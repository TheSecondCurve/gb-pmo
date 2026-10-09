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

## K17 exhaustive-deps 存量裁决：4 处 useCallback 重构 + 2 处刻意挂载禁用，规则恢复 error

- 决策：6 条 react-hooks/exhaustive-deps 警告逐个裁决——4 处「key 变化重取数」惯用法（ProjectDetail 主刷新/TaskRecords/TaskRefs、Chat 消息流）重构为 `useCallback(key)` + effect 依赖该回调（行为恒等、规则自洽；store 的 toast 本就 useCallback([]) 稳定）；2 处刻意「仅挂载一次」保留并显式标注：Chat 首载会话列表（读挂载时刻 activeId 闭包做首会话一次性自动选中）与 DigestBody（fn 是父组件内联新建的 prop，入依赖会每次父渲染重跑 LLM 梳理）。eslint 规则从 warn 恢复 error，新违规挡 CI。
- 理由：warn 级警告在扩展期会被无视成噪音；裁决后要么结构自洽要么显式标注意图，规则才有牙齿。
- 推翻：K15 的「exhaustive-deps 降为 warn」临时降级。


## K18 任务删除 = deleted_at 软删（S36，v0.40）

- 决策：项目实例任务开放删除（web `DELETE /api/v1/tasks/:id` 全员 + Agent action `delete_task` write scope），语义=软删——`tasks` 加 `deleted_at` 列（迁移 0020），删除落值、行保留；任务参考资料同事务一并软删，更新记录与讨论面历史事件保留。读侧全仓补 `deleted_at IS NULL`（列表/详情/盘点/未指派/逾期/指标/日报/晨报/梳理/机器人查询/LLM 抽取上下文/结项 openTasks 校验）；已删任务的待确认建议确认时 409 不复活。**不引入 cancelled 状态值**；机器人指令面不开放删除；不做恢复入口。
- 理由：v0.6 已把任务状态裁成 todo/doing/done 三档，加 cancelled 会污染结项校验（`status != 'done'`）与指标 OPEN_TASK 等大量既有口径，侵入远大于加列；deleted_at 与 task_refs/chat_sessions 既有软删范式一致，行保留满足留痕与审计可追溯；建错/录错任务无入口删除会持续污染任务面与指标，是真实痛点。
- 推翻：v0.39 S35 负面清单「任务无删除语义」（PRD L494/L746 已修订为仅机器人面不做）。

## K19 项目硬删除 = 软删约定的唯一例外（S37，v0.41）

- 决策：项目支持**物理删除**（DELETE 行，同事务级联抹除 tasks / task_refs / task_records / project_events / milestones / channels / calendar_sync；unrouted_messages / pushes 解除项目引用但保留行；audit_logs 落 `project.hardDelete` 快照成为唯一痕迹）。仅系统管理员（web `requireAdmin` + Agent `delete_project` adminOnly），任意状态可直接删（含在跑项目）。「取消」保留为业务终态（留痕可追史），硬删除为数据抹除手段，两者并存；飞书侧日历事件/群聊等外部资源不追回。
- 理由：测试/演示/误建项目的数据清理是真实需求，cancelled 行保留语义满足业务终态但抹不掉数据；FK ON 下单表 DELETE 会被约束拒绝，必须显式按序级联；不可逆破坏性操作收敛 admin-only（对齐 S17-13 删类型口径）；任意状态可删由用户拍板——硬删的定位就是清理手段，不该要求先走业务终态。
- 推翻：AGENTS.md §4「删除 = 软删」约定在本场景的唯一例外（用户 2026-10-09 拍板）；任务域维持软删不变（K18）。

## K20 任务责任人默认未指派——推翻 D3（S38，v0.42）

- 决策：任务责任人与项目牵头人解耦——一切建任务通道（`createTask` web 逐条/提议 add_task、`createProject` 模板实例化/自定义清单）责任人一律**默认未指派（NULL）**，不再回填 `project.leadMemberId`；创建可显式指定，传入非空责任人补在职校验（400「责任人不存在或已离职」，对齐牵头人/建议面口径，补齐原 FK-only 缺口）。列自 0001 即可空，零迁移；未指派为一等公民状态，由 `listUnassigned`（S2-1）/`unassigned_tasks` 指标/`tasksInventory` 盘点承载——立项实例化任务进未指派清单是初次分配的正常工作队列而非告警噪音。未指派任务的逾期预警**不做牵头人兜底**（按人队列天然不含未指派行）。
- 理由：D3 让批量立项后的任务面看似有主实则未分配，「该分配给谁」的决策被默认值掩盖，未指派监控形同虚设；牵头人是项目第一负责人而非全部任务的执行人，两个概念不该由默认值混同。初次分配的效率问题由 S39（AI 初始分配）正面解决，而非靠错误的默认值。
- 推翻：D3「模板生成任务默认责任人=项目牵头人」（用户 2026-10-09 拍板）；S1-2/S2-1/S35-1 验收标准同步修订。

## K21 AI 初始分配 = LLM 信任边界的限定例外（S39，v0.42）

- 决策：项目类型加初始化提示词（`project_types.init_prompt`，自然语言的任务分配与倒排日期逻辑）；AI 初始分配拆为**草案**（`draftInitAssignments`：LLM 读提示词+未完成任务+成员名册产 `{taskId, responsibleMemberId, planStartDate, planEndDate}` 全任务覆盖草案，白名单后校验+warnings，不落库）与**应用**（`applyInitAssignments`：逐行校验后单事务批量落库，一条讨论面记录+一条 `task.initAssign` 审计快照，不做逐任务 owner_change）。通道：web=草案弹窗人审后应用；**Agent action `apply_init_assignments` 可不经页面确认直接批量写入**（write scope）——这是「LLM 不直接改任务责任人/排期」（AGENTS.md §4/负面清单）的**限定例外**，仅限初始化分配这一个 action（用户 2026-10-09 拍板）；抽取/建议/提议/机器人通道边界不变，机器人面不开放此能力。LLM 产绝对日期由「人审（web）+ 严格校验（双通道）」兜底，S1-7 确定性均分倒排保持为立项默认值，两者互补不替代；不做立项后自动触发。
- 理由：初始化分配是「人显式发起、结果立即可见可改」的低风险场景，且 PAT write scope 本身已可经 SQL 端点直接 UPDATE tasks——新 action 只是把这一能力语义化并加上逐行校验与审计，没有扩大实际攻击面；而一次配置类型提示词、每个新项目一把完成初次分配，是用户明确的效率诉求。web 侧保留人审是因为页面上「看一眼再点」成本极低、收益是拦下 LLM 的误判。
- 推翻：无（AGENTS.md 负面清单在本场景的限定例外，负面清单原文保留并加注）。

## K22 LLM 超时 = 一次重试 + 504 中文指引 + 默认 120s（S40，v0.43）

- 决策：LLM 适配层超时（AbortController 掐断）自动原样重试一次，仍超时抛 504 中文指引（含当前 timeoutMs 与调整入口，不透出英文 DOMException 原文）；默认 `timeoutMs` 60s→120s（GLM-5.3-Flash 大 JSON 实测约 117s 的证据）；配置台 LLM 卡片补超时编辑（1s~600s 整数校验）。非超时错误（上游非 2xx）不重试；JSON 模式 400 去参重试的既有行为不变。
- 理由：S39 的大 JSON 输出把「非流式一次性等待」的 wall-clock 推过 60s，默认值对 GLM 类别必超；一次重试覆盖瞬时排队/抖动，持续超时是配置/上游问题——给人可执行的指引比死等或英文原文有用；超时旋钮此前只能经 `put_setting` 调，配置台补字段让管理员自助。
- 推翻：无（v0.14 适配层默认超时值按线上实测证据调整）。

## K23 状态色语义唯一来源 = 前端 TONE 表；逾期红优先于状态色（S41/S42/S43，v0.44）

- 决策：任务/里程碑状态的颜色语义集中在**前端 `types.ts`** 的 `TASK_STATUS_TONE` / `MILESTONE_STATUS_TONE` 两张表（映射到 Badge 既有五色语义：todo=muted 灰、doing=info 蓝、done=ok 绿；里程碑 met=绿 / missed=红 / planned·cancelled=灰），组件一律查表，不散落色值字符串；**逾期（`isOverdue`，后端 BJ_TODAY 口径）红优先于状态色**（行底色与甘特条）。任务级甘特复用 S30 `gantt.ts` 纯函数与条形四形态、「无日期不入轴收未排期组、不虚构日期」的松散排期语言。项目进度计数（`tasksTotal/tasksDone`）是 `listProjects` 的**行级派生属性**（仿 `overdueTasks` 子查询模式），不进 metrics.js 指标层；枚举层（server/engine/enums.js）不增 color 字段——色彩是展示层关注点，不进数据契约。
- 理由：颜色是「看一眼分状态」的纯展示语义，集中一张表即可全局对齐、单点调整；逾期是比状态更紧迫的信号，视觉上必须赢（否则逾期任务淹没在同色行里）；进度计数与 `overdueTasks` 一样是行级派生属性而非跨项目聚合指标，放 `listProjects` 子查询避免为展示新开指标口径；枚举层保持 `value→label` 扁平映射不变，SKILL.md drift check 与 Agent 契约零影响。
- 推翻：无。

## K24 初始分配草案 = 202 + 轮询的异步作业（S44，v0.45）

- 决策：初始分配草案拆两段——启动端点同步校验后立即 202 返回 draftId（LLM 进程内后台执行），新增轮询 GET 返回 running/done/error（错误以 200 载荷返回，规避 v0.21 已知的 PaaS 网关 5xx 响应体替换）；轮询分两路：web 会话路由 + Agent 侧 `GET /api/v1/agent/draft-init-assignments/:draftId`（PAT read scope 即可；非 agent 路由维持仅会话，不为轮询扩 Bearer 面）；作业注册表=进程内 Map（10 分钟 TTL + 200 容量，不落库、不引外部队列组件）；web 弹窗 2s 轮询显示进度。应用端点维持同步（纯 DB 事务，毫秒级）。S40 的超时重试保留在 LLM 调用内部。
- 理由：线上实测 Zeabur 前 Cloudflare 边缘对源站响应约 120s 即 524 掐断，而 GLM 大 JSON 稳态要约 2 分钟——同步等待模型与边缘上限架构性不兼容（用户 2026-10-09 拍板异步化，否决 SSE 流式：推理阶段 chunk 行为不确定且最坏仍挂 4 分钟）；单进程部署下进程内 Map 即满足瞬态作业语义，无需引入队列/worker 组件（负面清单不变）。
- 推翻：无（S40「不做流式改造」结论经此确认并落在另一路径上；S39 草案不落库口径不变）。

## K25 对话面确认卡收敛：直改为默认，确认卡只留终态操作（S20/S24/S25/S35 修订 + S4-7，v0.46）

- 决策：**对话面（飞书机器人/web AI 助手，K12 统一管线）的写操作不再逐条出确认卡**（用户 2026-10-09 拍板：「只有删除动作做确认，其他直接操作并返回结果；批量操作只确认一次」）。①`suggest_event`（任务状态/日期/责任人、里程碑改期/状态）落建议型事件后立即以发令人身份走 `confirmEvent` 同一口子生效（status=effective、decided_by=发令人，终态/软删守卫与事务全继承；不再 pushSuggestion），并支持 `items[]` 批量——逐条独立事务生效、一条汇总回执单列失败原因（agent 循环「写即终止」不变，批量在一个 write 内表达）；②`propose` 分流：`cancel_project`/`close_project` 维持「提议→确认卡→confirmProposal」（HMAC/确认矩阵不变），其余 kind（add_task/add_milestone/update_project/create_project/create_project_type）不再落 proposals 表，软校验后**复用 `PROPOSAL_KINDS[kind].canConfirm` 前置为发起人执行权限校验**、通过即 `spec.apply` 直写既有 engine——权限模型不变，只少一步点按；③`bind_channel` 直写 upsertChannel（发起时牵头人/admin 校验不变）。**抽取面信任边界不动**（定时抽取/梳理的建议仍 pending 等人确认），但 web 项目详情页待确认建议新增「全部生效/全部驳回」批量端点与按钮（confirmEvents/rejectEvents 逐条同口子应用、单条 409 不阻塞、聚合回执，S4-7）。卡片回调的 suggest/bind 分支保留以兼容存量卡片点按。Agent SQL/action 通道（SKILL.md 守则）与 web 表单直改通道不变。
- 理由：对话面的写是**人的明确指令**经 LLM 解析，确认卡只剩「人核对解析值」的纠错价值而无权限价值（v0.34 起任务面建议本就任意绑定成员可点），逐条点按是纯摩擦；且任务面变更错改可逆（状态/日期/责任人再说一句即可改回），回执明示解析值即可兜底。不可逆的终态操作（取消/结项）保留人拍板——这与「确认卡只留删除级动作」的拍板一致。批量直改用一条汇总回执取代 N 张卡。抽取面是 LLM 对群聊的**被动推断**（误抽率有采纳率告警 S3-5 在监控），人确认是防误改任务面的最后防线，维持不动；其痛点「逐条确认」由 web 一键批量解决。canConfirm 复用为执行校验使权限语义零漂移。
- 推翻：K9「写路径唯一不变量：suggest+bind 出确认卡」的对话面部分（propose 确认卡收敛为 cancel/close 两类）；K12/K21 确立的**抽取面**边界不变。

## K26 财务记录 = 讨论面纯文本事件分类，不是财务管理功能（S4-9，v0.47）

- 决策：事件类型枚举新增 `finance`（财务记录），承载项目执行中的财务类事实沟通（回款进度、开票、费用争议等一句话文本）；通道与 record 型信任边界同口径——web 手动补充、机器人/web AI 助手 `record_event`、IM 定时抽取（记录型，自动生效）均可归类；建议型白名单（`confirmEvent.applyTaskPatch` 的 status/日期/责任人字段子集）天然不涉及财务，无「LLM 直改财务」面。**严格限定为记录分类**：不含金额字段（「本项目无金额字段」约定不变）、不建财务科目、不做收入/成本/合同/回款/发票管理与财务对接。事件流展示侧同步分栏（S4-8）：进展/风险·阻塞/财务记录三固定栏 + 其他类型筛选时序栏；引擎留痕摘要写操作时刻成员姓名（S4-10，append-only 历史不回改，与成员 id 变更不回改同口径）。
- 理由：项目执行中财务沟通客观存在，此前只能混入「进展」或无处归类，在混排时间线里淹没；用户 2026-10-09 拍板要独立栏目。限定为纯文本分类可使负面清单边界零漂移——金额、账期等结构化财务管理仍明确不做。留痕摘要姓名化是同一屏的可读性修复：讨论面是给人读的，成员编号不可读；姓名按操作时刻快照写入，与 append-only 审计语义自洽（改名不影响历史可读性）。
- 推翻：无（负面清单「不做收入/成本/合同/回款、发票、财务对接」原文维持，finance 仅是讨论面记录分类，K26 加注边界）。

## K27 任务甘特轴右端 = 绝对日期锚定 + 开放任务中位时长估算（S42-5/S42-6，v0.49）

- 决策：项目详情任务级甘特（S42）两层排布修正。①**轴右端锚定**：项目交付日期（`planEndDate`）首次进入轴线计算，轴右端=max(交付日期,任务计划结束日期,今天)+1 天呼吸边（左端 7 天不变；今天在候选中保证今日线不飞出轨道）；轨道从「日宽 2~12px、约 640px 封顶」的固定像素宽改为弹性布局——`width:100% + min-width=标签列+总天数×2px`，跨度短拉满卡片可用宽度、跨度长横向滚动，今日线改 CSS `calc()` 百分比定位。②**开放任务估算排布**：只有开始日的任务按同项目起止齐全任务的中位时长（含首尾，取下中位）估算名义结束日，无样本默认 14 天（用户 2026-10-09 拍板）；开放条按估算时长绘制、渐隐收尾（不再一路冲到轴右端），名义结束日参与轴右端取大——无绝对结束日可锚时整张图仍有确定右端。估算是纯展示层排布，不写回任何日期字段、不进指标。项目组合页时间线（S30）维持旧口径：`computeAxis` 数字形参（padDays）与 `barLayout` 不传估算参数的行为完全不变。
- 理由：固定 7 天右端留白 + 日宽封顶使跨度短的甘特缩在卡片左半、右侧大片空白（用户 2026-10-09 反馈）；项目交付日期是项目最重要的绝对时间点却不入轴，导致甘特右端与项目死线脱钩；开放条无参照地冲到轴右端，在没有绝对右端时把图无意义拉长。中位时长取自同项目真实任务，比全局常数更贴合本项目节奏；14 天回退值由用户拍板。估算不落数据，守住「不虚构日期」口径——数据库里的松散排期语言不变，只有画布上的排布。
- 推翻：S42（v0.44）「条形四形态与 S30 完全一致」中开放条「延伸到时间轴右端」的语义（仅详情页任务甘特；组合页 S30 时间线形态与语义不动）。
