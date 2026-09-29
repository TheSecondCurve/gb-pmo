# gb-pmo · 企业项目大脑（Project Brain）

LLM 驱动的多项目管理核心：项目全生命周期（立项→排期→执行→结项）、IM 聊天自动抽取、by 项目/by 员工梳理建议、日报与预警、Agent 全功能接入。需求与决策见 `docs/prd.md`、`docs/design.md`（决策日志 K1-K8）、`docs/scenarios.md`（测试追踪）；六份标准的项目副本在 `docs/standards/`。

## 快速开始（开发）

```bash
npm install
GB_PMO_SESSION_SECRET=$(openssl rand -hex 24) \
GB_PMO_ADMIN_USER=boss GB_PMO_ADMIN_PASS=init-pass-123 \
npm run dev:server          # 后端 :8086
npm run dev:web             # 前端 Vite :5186（代理 /api 与 /agent）
```

登录 http://localhost:5186 → 全局看板 / 项目列表 / 配置台。

## 生产（Docker 单容器单进程）

```bash
cp .env.example .env        # 填会话密钥与 bootstrap 管理员
docker compose up -d --build
```

- SQLite 数据在 named volume `/app/data`，每日自动 `.backup` + gzip 滚动 30 天（`scripts/backup.sh`）。
- skill 包随镜像分发（`COPY skills ./skills`），更新 = 客户端重跑 install.sh。

## Agent 接入（形态 B，D4：SQL + REST action 双通道）

```bash
curl -fsSL http://<服务器>:8086/agent/skill/gb-pmo/install.sh | sh   # 安装 skill
curl -fsSL http://<服务器>:8086/agent/login.sh | sh                  # 终端授权换 PAT
client.sh sql "SELECT id,name,status,priority FROM projects WHERE status IN ('planning','active','paused')"
client.sh metric overdue_tasks '{"groupBy":"project"}'               # 指标以 metrics 端点为准
client.sh action generate_person_digest '{}'
```

守则（SKILL.md 全文随 skill 下发）：指标优先走 metrics 端点；口述更新一律 INSERT 建议型事件等人确认，绝不直接 UPDATE tasks。

## 质量门禁（照抄可跑）

```bash
npm test                # 79 条：P0 场景测试 + 安全必测清单 + 前端冒烟
npm run coverage        # v8 核心目录 ≥80%（当前 语句 97% / 分支 82% / 函数 97%）
npm run check:scenarios # 需求追踪：PRD P0 场景 ↔ 测试比对，缺失红
npm run check:skill     # SKILL.md schema 区块 drift check
npm run typecheck && npm run build
```

## 大脑启用清单

1. 配置台填 DeepSeek（base_url/api_key/model + 测试连接）——未配置时大脑走确定性降级（只产记录型事件）。
2. 飞书：按 `docs/prd.md` 附录 A.1 创建自建应用、开 `im:message.group_msg`、机器人进项目群，配置台填 App ID/Secret。
3. 企微：需付费开通会话存档 + 部署官方 C SDK 代理（附录 A.2 step-by-step）；未开通时企微渠道自动降级。
4. `ENABLE_SCHEDULER=1` 启动调度（每小时抽取 / 15 分钟预警 / 日报按配置时点推送）。

## 明确不做（节选，全文见 docs/prd.md §9）

收入/成本/合同/回款、发票与财务对接、工时绩效、行级数据权限（全员透明）、LLM 冒充成员发言、自动重排期求解器。
