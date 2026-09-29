# AGENTS.md — gb-pmo（企业项目大脑）

读者首先是编码 Agent。改代码前先读完本文件与 `docs/design.md`（决策日志 K1-K7）。

## 1. 工程结构与分层

```
server/                    # Fastify 后端（内网单进程）
├── index.mjs              # 入口：建库、迁移、启动、托管前端 dist/
├── routes/                # 路由层：参数校验 + 权限校验 + 调 engine，禁止写业务 SQL
├── engine/                # 业务引擎：纯函数/类，接收 db，不感知 HTTP
├── agent/                 # Agent 接入栈：login.sh/install.sh 渲染、PAT、SQL/action/metrics 端点
├── brain/                 # 大脑：LLM 适配（DeepSeek）、IM 连接器、抽取/分拣/梳理/日报/预警/调度
├── db/                    # better-sqlite3 连接（连接层 PRAGMA）、migrations/*.sql、schema.ts（Drizzle 查询类型）
└── test/                  # 测试与源码分层放置（*.test.mjs），按 PRD 场景组织命名
src/                       # Vite + React SPA（hash 路由、Context store、手写极简组件）
skills/gb-pmo/             # Agent skill 包源（随部署分发，Dockerfile 必须 COPY）
scripts/                   # backup.sh、check-scenarios.mjs（需求追踪门禁）、gen-skill-schema.mjs（drift check）
docs/                      # prd.md / standards/ / design.md（决策日志）/ scenarios.md（追踪锚点）
```

- 分层规则：routes → engine → db。engine 不 import fastify；测试直调 engine 或 fastify.inject，不 listen、**不 mock 数据库**（每测试文件临时真 SQLite 库）。
- 指标口径唯一真相源在 `server/engine/metrics.js`；routes 与 SKILL.md 都不得另写指标 SQL。

## 2. 常用命令（照抄可跑）

```bash
npm install            # 安装依赖
npm run dev            # 后端 :8086 + 前端 Vite dev（代理 /api）
npm test               # Vitest 全量（server 场景测试 + 安全清单 + 前端冒烟）
npm run coverage       # v8 覆盖率，核心目录 ≥80% 门禁
npm run check:scenarios# 需求追踪：PRD P0 场景编号 ↔ 测试文件比对，缺失红
npm run check:skill    # SKILL.md schema 区块 drift check
npm run build          # 前端构建到 dist/（后端生产托管）
npm start              # 生产模式启动（NODE_ENV=production，托管 dist/）
```

## 3. TDD 契约与需求追踪

- 本文件生效 engineering-standards.md §1/§2：**先改 PRD → 再改测试（红）→ 再改实现（绿）**，反着走禁止。
- 每个 P0 场景至少一条用户视角测试，测试名带场景编号（`S3: ...`）；`docs/scenarios.md` 是锚点，CI 用 `check:scenarios` 比对。
- 禁止为凑绿修改既有测试断言；认为旧测试错了 → 停下报告，由人裁决。
- 新增/变更验收标准时同步更新 `docs/prd.md` 与 `docs/scenarios.md`。

## 4. 编码约定

- JSON 一律 camelCase；时间戳 epoch 毫秒；本项目无金额字段（PRD 裁剪）。
- 删除 = 软删（`deleted_at`/状态枚举），人员离职 = 软删 + 强制转交。
- 状态一律用中央枚举 `server/engine/enums.js`（带中文 label），不散落字符串。
- 讨论面（project_events）append-only：只插入，不 UPDATE 已生效事件的业务内容。
- LLM 信任边界：记录型事件可自动生效；建议型（任务状态/排期/优先级/依赖/责任人）必须人确认。
- 密码 scrypt（K1）；会话 cookie HMAC 签名 httpOnly；Agent PAT 只存 hash。

## 5. 明确不要做（负面清单）

- 不做 JWT；不上 Redis/消息队列/微服务；不升 PostgreSQL（大客户条款未触发）。
- 不做收入/成本/合同/回款、发票、财务对接、工时绩效（PRD「明确不做」）。
- 不做行级数据权限/脱敏分级（D1 全员透明；只有 admin/普通两档功能角色）。
- 不让 LLM 直接改任务状态/排期/优先级/依赖/责任人（只产建议型事件）。
- 不做 LLM 以成员身份在 IM 群发言（只读抽取 + 定向推送）。
- 不做自动重排期求解器、代码仓库/CI 集成、CRM。
- 前端不引组件库/路由库/状态库（手写极简组件 + hash 路由 + Context store）。
- 不 mock 数据库写测试（SQLite 临时库足够便宜）。
