# 标准技术架构

> 用法：这是**默认决策清单**，直接采用；只有「待决策」项需要逐项目确认。偏离默认决策必须在项目实例中写明理由。

## 默认架构：前后端分离的内网单进程应用

| 层 | 默认选型 | 说明 |
|---|---|---|
| 前端 | Vite + React SPA + Tailwind CSS | 手写极简组件层（Modal/Btn/Field/Toast 等），不用组件库；详见「前端工程规范」 |
| 后端 | **Fastify** + better-sqlite3 | REST 风格 `/api/*` 端点，内网单进程（沿用 gb-crm 实践）；生产由后端进程直接托管前端 `dist/`，部署物仍是单进程 |
| 数据库 | **SQLite（better-sqlite3）** | 标准选型：客户数据量小、单进程、零运维。**仅大客户升 PostgreSQL** |
| ORM | Drizzle | 轻量、迁移可追踪，SQLite/PG 双兼容（沿用 gb-crm 实践） |
| 认证 | 服务端 session + 签名 httpOnly cookie（HMAC）；密码 argon2id | 不做 JWT；Agent 访问走独立 PAT（见下） |
| 文件存储 | 本地磁盘 + 定期备份（或 S3 兼容对象存储） | 视部署方式定 |

## 为什么默认前后端分离 + SQLite 单进程

目标客户是小企业小团队，用户几十到几百、数据量小。前后端分离（Vite SPA + Fastify REST）单进程足够支撑，且部署物只有一个容器、零外部依赖——这是"花小钱"叙事的技术基础。gb-crm 已验证此形态（Fastify + better-sqlite3 内网单进程）。前后端分层还带来两个实际收益：后端天然可服务 Agent/IM 等非浏览器客户端；前端是纯 SPA，高密度交互（就地编辑、批量操作、即时反馈）更顺手。微服务/中台带来的运维成本远超收益。**大客户（数据量大/多实例/合规要求高）才升 PostgreSQL**，届时逐项重新评估。

### SQLite 工程规范（沿用 gb-crm 实践）

- 每条连接设置 PRAGMA：`WAL` / `busy_timeout=5000` / `foreign_keys=ON`——**只在连接层执行，不写进 migration**。
- 库文件创建后 `chmod 600`，只放 named volume / 数据目录，不进镜像。
- 备份只用 `sqlite3 "$DB" ".backup ..."`，**禁止 `cp` 热库**。
- handler 是同步 SQLite，会堵事件循环：接受这一点，不上 worker pool / Redis。

## 标配模块（每个交付系统都必须有，不许裁掉）

1. **认证 + RBAC**：见 permission-design.md（小团队按裁剪规则简化）。
2. **Agent 接入栈**：`/agent/*` 公开端点（login.sh / install.sh / skill 源文件下发）+ PAT 令牌模型（hash 存储、read/write scope、过期与吊销、admin 治理页）+ 单一 SQL 端点 + skill 包。完整规范见 agent-integration.md 形态 B。**skill 包源目录必须随部署包分发**（Dockerfile 含 `COPY skills ./skills`）。
3. **审计日志**：关键操作（删除、审批、导出、令牌签发/吊销）记录谁、何时、对什么、做了什么。
4. **备份**：每日 `.backup` + gzip，滚动保留，见 deployment.md。
5. **数据分析栈**：指标定义层（口径唯一真相源）+ 页面 interactive dashboard + Agent metrics 端点（`/api/v1/agent/metrics[/query]`）。实体设计必须过维度建模 checklist（事实/维度分离、双时间戳、金额独立成列、状态枚举、软删）。完整规范见 analytics-design.md。

## 前端工程规范（默认形态：Vite + React SPA，沿用 xiaowen-ynab 实践）

前端是纯静态 SPA，后端是 Fastify REST 服务。开发时 Vite 把 `/api` 代理到后端端口，生产由 Fastify 进程直接托管 `dist/` 静态文件，**部署物仍是单进程**。

注意：xiaowen-ynab 的 localStorage JWT 登录是单用户做法，**企业交付不沿用**——认证仍走默认的服务端 session + httpOnly cookie（见上表）。下表只吸收其前端工程与交互做法：

| 项 | 选型 | 说明 |
|---|---|---|
| 构建 | Vite + React 18 + TypeScript（SPA） | 无 SSR |
| 路由 | Hash 路由（`<a href="#/x">` + 自写 `useHashRoute`） | 不引 react-router：静态托管无需 history fallback，刷新/直达链接天然可用 |
| 后端 | **Fastify** + better-sqlite3 | REST 风格 `/api/*` 端点；业务引擎与路由分层（engine / routes 分文件） |
| 状态 | React Context 单一 store（`store.tsx`） | 启动时一次性拉 `/api/bootstrap`（账户+设置+字典初始化），写操作后调 `refreshBoot()` 或端点直接回传最新切片；不引 redux/zustand/react-query |
| 数据访问 | 手写 `api.ts` fetch 封装 | 统一携带凭据、统一错误（`ApiError`），每个端点一个具名方法，类型与后端共享 `types.ts` |
| 组件 | 手写极简组件层（Modal/Btn/Field/Spinner/Toast）+ Tailwind v4 | 不用组件库；图标 lucide-react；图表 recharts；富文本 react-markdown + remark-gfm；图表渲染 mermaid |
| 样式系统 | Tailwind v4 `@theme` 在 CSS 里声明 design token | 单个 `styles.css` 承载 token、基础样式、复用 class（如 `.num` 等宽数字、`.cell-input` 行内编辑框） |
| 国际化 | 单文件字典 `i18n.ts`：`zh` 对象为准，`en: typeof zh` 类型约束保 key 同步 | `makeT(lang)` 返回 `t(key, vars)` 支持 `{n}` 插值；语言存 localStorage 并同步写入设置 |
| 测试 | Vitest + Testing Library（jsdom） | 前后端同仓测试，页面级测试与组件同目录 |

### 前端交互规范（YNAB 式交互质感，自 xiaowen-ynab 提炼，所有项目必须遵守）

1. **就地编辑优先于表单页**：表格/列表中的值点击即变为输入框（`.cell-input`），Enter 保存并继续下一项、Esc 取消、blur 提交；能用行内编辑解决的绝不开新页面。
2. **破坏性操作强制确认**：删除、批量删除、关闭账户等一律 Modal 二次确认，文案写明影响范围（"转账会连同对侧记录一起删除"）；AI 写操作强制确认卡（见 agent-integration.md）。
3. **反馈即时且短**：所有成功/失败走右下角 Toast（约 2.6s 自动消失，不打断流程）；异步按钮置 loading/禁用态；页面切换与弹层用 ≤0.2s 的 ease-out 微动效（pop/fade/slide 三档），不用弹簧物理动画。
4. **键盘流**：Enter 保存并新增下一条、Esc 关弹层、搜索框即时过滤；移动端导航抽屉点击后自动收起。
5. **布局骨架**：左侧固定 Sidebar（导航 + 业务实体分组列表 + 底部设置区），主区单页滚动；移动端折叠为顶栏 + 抽屉 + 遮罩。数字一律等宽数字（tabular-nums）。
6. **空态即引导**：空数据页给出产品方法简介 + 「载入示例数据 / 从零开始」两个主行动，不放空洞插画。
7. **批量操作**：多选后出现浮动操作条（批量分类/批量删除/全选本页），完成后 Toast 汇报影响条数。
8. **设置页即控制台**：分区卡片式表单（通用/AI/渠道/备份），每区独立保存 + 「测试连接」类即时验证按钮，密钥字段留空表示不修改。

## 代码结构约定

```
src/                # 前端：main.tsx / App.tsx / store.tsx / api.ts / i18n.ts / types.ts
├── components/     # 极简组件层（ui.tsx 等）+ 业务组件
└── pages/          # 一页面一文件，测试同目录（*.test.tsx）
server/             # 后端 Fastify：index 入口 / routes 路由 / engine 业务引擎 / db / migrations
│                   # /agent/* 端点 + 单一 SQL 端点也在此（标配）；测试与源码同目录（*.test.mjs）
skills/<产品名>/      # Agent skill 包源：SKILL.md + 客户端脚本（标配，随部署分发）
```

## 本项目决策（2026-09-29 kickoff 拍板）

- [ ] UI 组件库主题与品牌定制范围
- [ ] 是否需要移动端（默认：响应式 Web，不做原生 App）
- [ ] 是否触发大客户条款：数据量/并发/合规要求超出 SQLite 单进程 → 升 PostgreSQL（连带重新评估备份、SQL 端点读判定、部署拓扑）

- [x] UI 主题与品牌定制：**不定制**，沿用极简组件层默认样式（默认值）
- [x] 移动端：**响应式 Web**，不做原生 App（默认值）
- [x] 大客户条款：**不触发**——数据量/并发/合规均在 SQLite 单进程范围内（默认值）

偏离记录（见 docs/design.md）：
- **K1**：密码哈希以 node:crypto scrypt 替代 argon2id（减少一个原生编译依赖）。
- **K2**：不引入 ORM，查询层直用 better-sqlite3 prepared statements + 手写 SQL 迁移（Agent 接口本身是 SQL，保持单一数据语言；推翻默认 Drizzle）。
