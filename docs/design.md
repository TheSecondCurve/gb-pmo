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
