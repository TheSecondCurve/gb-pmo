# AGENT 集成标准方案

> 本方案分两种形态。**形态 B（客户自有 Agent 接入）是默认推荐**——它是"数据建模 + Agent 飞轮"的关键：系统交付后，客户用自己的 AI Agent 就能查询、补录、分析，新用法自己长出来，而不是每个需求都回来找我们开发。形态 A（系统内置 AI 助手）按需叠加。

---

## 形态 B：客户自有 Agent 接入（默认，抽象自 gb-crm K35 渠道 A）

### 总体链路

```
客户本机的 Agent（Kimi Code / Codex / Claude）
   │  一条命令：curl -fsSL http://<系统地址>/agent/skill/<产品名>/install.sh | sh
   ▼
安装器：下载 SKILL.md + 客户端脚本（装到 .agents/skills + codex/claude 全局目录）
   │  引导授权：用户名/密码（终端交互，不经 Agent）→ 签发 PAT
   ▼
本机凭证 ~/.<产品名>/credentials.json（600，skill 本身不含任何密钥）
   │
   ▼
Agent 调客户端脚本 → Bearer PAT → 单一数据端点（SQL）→ 数据库
```

### 服务端组件清单（每个交付系统都要实现）

| 端点 | 鉴权 | 作用 |
|---|---|---|
| `GET /agent/login.sh` / `login.ps1` | 公开 | 授权脚本：交互输入用户名/密码 → 换 PAT → 写本机凭证 |
| `GET /agent/skill/<名>/install.sh` / `.ps1` | 公开 | 安装器模板，服务端渲染时注入 baseUrl 与 skill 版本号 |
| `GET /agent/skill/<名>/SKILL.md` + 脚本文件 | 公开 | skill 源文件（从部署包内目录读取） |
| `POST /api/v1/agent/sql` | 仅 Bearer PAT，cookie 一律 403 | 单一数据端点 |
| `GET /api/v1/agent/metrics` | Bearer PAT（read scope） | 指标目录：指标定义卡（名称、业务定义、可切维度、时间口径） |
| `POST /api/v1/agent/metrics/query` | Bearer PAT（read scope） | 按指标+维度+时间范围取数，与页面 dashboard 同源同口径（见 analytics-design.md） |
| `GET/DELETE /api/v1/auth/tokens` + admin 管理页 | 登录用户 / admin | 令牌自助管理 + admin 吊销任意令牌 |

公开端点的信任面成立的前提：**skill 与脚本零密钥**。凭证只在客户本机。

### 关键决策（直接采用，勿重新发明）

1. **更新 = 重跑同一条命令**。安装器本体每次现取、skill 文件每次覆盖，服务器单方面决定最新态；版本号单一真相源 = SKILL.md front-matter 的 `version` 字段。不做版本协商、不做升级通知。
2. **授权与安装分离**。本机已有凭证时默认跳过授权（`X_SKIP_LOGIN=1` 只装文件 / `X_FORCE_LOGIN=1` 强制重签）。密码只走终端 `/dev/tty`（静默回显），绝不经过 Agent 对话；非交互场景走环境变量（CI 可用）。
3. **PAT 模型**：令牌只存 hash，库内留前缀用于展示与吊销定位；scope 分 `read`/`write`；默认 90 天过期；吊销置 `revoked_at`+`revoked_by` 不删行；**禁用/删除用户联动撤销其全部令牌**。
4. **单一 SQL 端点，不做 Agent 专用 REST**。表结构、枚举翻译、业务守则写进 SKILL.md 让 Agent 遵守，而不是为 Agent 开发一套新 API。schema 文档用脚本从 migration 半自动生成（列结构自动同步，含义列手写保留）。**唯一例外是指标分析**：指标类查询走 metrics 端点（指标目录 + 参数化取数），口径与页面 dashboard 同源，SKILL.md 必须声明「指标以 metrics 端点为准，SQL 自算不一致时以端点为准」（见 analytics-design.md）。
5. **端点安全判定规则**（gb-crm 实测版本）：
   - 读写双条件判定：`stmt.readonly === true` **且** SQL 以 SELECT/WITH/VALUES 开头，缺一落写分支；
   - **鉴权必须在 prepare 之前**（better-sqlite3 的 prepare 会立即执行 PRAGMA 改连接状态）；
   - DDL（CREATE/ALTER/DROP）对任何令牌一律 403；
   - 单语句；读上限 1000 行截断，`rows` 用数组不用对象（省 token）；
   - 凭据黑名单：结果列含 `password_hash`/`token_hash`、或 SQL 引用 sessions 表 → 403。
6. **写操作的信任水平**：写 SQL 绕过 service 层/审计/OCC，正确性由 SKILL 工作守则约束（手动补 `updated_at`/`updated_by`、软删不硬删、403 不换字段重试）。此信任水平**只在「内网部署 + 小团队 + 软删兜底 + 备份可恢复」同时成立时可接受**——这正是我们的目标客户画像，所以默认采用。

### 这个形态能替代什么（报价时要说给客户听）

- **历史数据迁移/补录功能** —— 不开发导入模块，Agent SQL 端点直接补录；
- **批量管理工具、临时报表** —— 客户用自然语言让 Agent 查/改；
- **大部分"二期小需求"** —— 客户在飞轮里自己解决。

### 安全细节清单（全是 gb-crm 踩过的坑，照抄）

- 安装器渲染时对 `Host` 头做白名单校验，非法值回退 `127.0.0.1`，防 shell 注入；
- 凭证文件原子写入（tmp + rename），目录 700 / 文件 600；
- 内网请求显式绕过 http_proxy（否则 localhost 被代理挂起）；
- 自定义 User-Agent（默认 Python UA 会被 Cloudflare Bot Fight 拦）；
- TLS 校验留 `X_INSECURE=1` 逃生门但默认校验（签发脚本），并在文档写清风险；
- shell 只用 `set -e` 不用 `set -u`（macOS bash 3.2 nounset 行为不一）；
- PowerShell 安装器必须纯 ASCII（BOM 会让 `irm|iex` 把首行当命令名）；
- 安装器同时装到当前 AGENT 项目级/用户级 + codex/claude 全局目录，一次安装跨 Agent 复用。

### 与标准栈的关系

本方案与标准技术栈（SQLite 单进程，见 tech-architecture.md）完全对齐：`stmt.readonly` 读写判定、`.backup` 备份兜底等机制原样适用，**无移植成本**。大客户项目升 PostgreSQL 时，读判定需重新设计（候选：端点内置只读数据库角色的独立连接执行读语句、写语句走另一角色），届时单独评估。

---

## 形态 A：系统内置 AI 助手（可选叠加）

在系统内提供对话式入口，AI 能做的是**调用系统已有的业务接口**，而不是直连数据库。

```
用户 ←→ AI 对话层 ←→ 工具调用（系统内部 service API）←→ 业务逻辑 + 权限校验 ←→ DB
```

**核心原则：AI 不绕过权限。** AI 以当前登录用户的身份调用业务接口，该用户看不到/不能做的，AI 同样看不到/不能做。

### 标准能力清单（按项目裁剪）

| 能力 | 说明 | 典型场景 |
|---|---|---|
| 数据问答 | 把用户问题转成受权限约束的查询 | 「我上个月成交额多少」 |
| 填单辅助 | 根据自然语言/附件预填表单，用户确认后提交 | 语音/文字描述生成工单 |
| 摘要与报告 | 对系统内数据生成周期性摘要 | 每周客户跟进汇总 |
| 知识问答 | 接入企业文档库（RAG） | 「报销标准是什么」 |

### 技术要点

- **模型接入**：通过统一网关（如 LiteLLM / one-api）对接，便于切换模型与计费审计；模型选型按数据敏感度定（敏感 → 私有化模型）。
- **工具定义**：把业务 service 层方法包装成 tool schema，附权限要求说明；不新增"AI 专用"旁路接口。
- **会话与数据**：对话记录存库并归属用户；发送给模型的上下文做最小化处理，敏感字段脱敏。
- **写操作二次确认**：AI 触发的任何创建/修改/删除，必须由用户在界面上确认后才真正执行。

---

## 本项目决策（2026-09-29 kickoff 拍板）

- [ ] 是否启用形态 A，启用能力清单中的哪几项
- [ ] 形态 A 模型方案：公有云 API / 私有化部署；数据出域限制
- [ ] 令牌过期时长（默认 90 天）与审计保留策略
- [ ] 部署在公网时，`/agent/*` 公开端点的信任面是否需要收紧（skill 虽无密钥，但暴露安装入口本身）

- [x] 形态 B：**标配启用**（默认值）
- [x] 令牌过期：**90 天**（默认值）；审计保留 365 天
- [x] `/agent/*` 公开端点信任面：**维持默认**（内网部署前提，PRD §8）；若上公网单独收紧
- [x] 形态 A（大脑）：**启用变体**——服务端定时/触发式 LLM 任务（抽取/分拣/日报/梳理/预警），模型 **DeepSeek API**（PRD D8），后台可配 base_url/api_key/model + 测试连接
- 偏离记录：**K3**——新增受限 action 端点（PRD D4：`trigger_extraction` / `generate_project_digest` / `generate_person_digest` / `push_report`），白名单枚举 + PAT write scope + RBAC + 审计。
