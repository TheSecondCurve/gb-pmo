---
name: gb-pmo
version: 0.1.0
description: 企业项目大脑——项目/任务/事件/成员的查询、维护与大脑功能触发
---

# gb-pmo 企业项目大脑 · Agent Skill

你是团队成员的 Agent，通过本 skill 读写项目大脑。所有数据全员透明（D1）。

## 快速开始

```bash
# 1. 安装 skill（更新 = 重跑同一条命令）
curl -fsSL http://<服务器地址>/agent/skill/gb-pmo/install.sh | sh
# 2. 终端授权（密码只走终端，不经 Agent 对话；凭证存 ~/.gb-pmo/credentials.json）
curl -fsSL http://<服务器地址>/agent/login.sh | sh
# 3. 使用（安装目录下的 client.sh）
client.sh sql "SELECT id, name, status, priority FROM projects WHERE status IN ('planning','active','paused')"
client.sh metrics
client.sh metric overdue_tasks '{"groupBy":"project"}'
client.sh action generate_person_digest '{}'
```

## 端点与分工（D4：SQL + REST action 双通道）

| 用途 | 端点 | 说明 |
|---|---|---|
| 查询/写入 | `POST /api/v1/agent/sql` `{"sql": "..."}` | 单语句；读=SELECT/WITH/VALUES；写需 write scope（INSERT/UPDATE/DELETE） |
| 指标 | `GET /api/v1/agent/metrics` | 指标目录（定义卡） |
| 指标取数 | `POST /api/v1/agent/metrics/query` `{"metric":"<id>","params":{}}` | **指标类问题优先走这里**；自算 SQL 与端点不一致时以端点为准 |
| 触发 | `POST /api/v1/agent/actions` | 白名单：trigger_extraction / generate_project_digest / generate_person_digest / push_report |

## 工作守则（必须遵守）

1. **指标以 metrics 端点为准**（口径同源 dashboard）；明细与自由查询才用 SQL 端点。
2. **写 SQL 守则**：手动补 `updated_at`（epoch 毫秒）与审计需要的字段；软删不硬删（人员改 status='offboarded'，不要 DELETE）；403 不换字段重试；只改自己为责任人/牵头人的对象，跨人变更走建议。
3. **LLM 信任边界**：口述更新一律 `INSERT INTO project_events (nature='suggestion', status='pending', ...)` 生成建议，等人在页面/接口确认；绝不直接 `UPDATE tasks` 改状态/日期/责任人。
4. 常用查询模式：
   - 「我本周的任务」：`SELECT t.id, t.title, t.plan_end_date, p.name FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.responsible_member_id=<我> AND t.status IN ('todo','doing','blocked')`
   - 「B 项目卡在哪」：看 project_events 最新 blocker/risk + 被阻塞任务（depends_on_task_id 未完成）。
5. 建议事件的 target 字段组合：task → status/plan_start_date/plan_end_date/responsible_member_id；milestone → target_object='milestone' 且 plan_date。


<!--SCHEMA:BEGIN（本区块由 scripts/gen-skill-schema.mjs 生成，勿手改；drift check 比对）-->

## 数据表（snake_case，与 Agent SQL 端点直连的结构一致）

### members

| 列 | 类型 | 说明 |
|---|---|---|
| id | INTEGER |  |
| name | TEXT |  |
| username | TEXT |  |
| password_hash | TEXT |  |
| feishu_id | TEXT |  |
| wecom_id | TEXT |  |
| team | TEXT |  |
| is_key_person | INTEGER |  |
| max_parallel_projects | INTEGER |  |
| role | TEXT | admin | member |
| status | TEXT | active | offboarded |
| updated_at | INTEGER |  |

### sessions

| 列 | 类型 | 说明 |
|---|---|---|
| id | TEXT |  |
| member_id | INTEGER |  |
| expires_at | INTEGER |  |

### tokens

| 列 | 类型 | 说明 |
|---|---|---|
| id | INTEGER |  |
| member_id | INTEGER |  |
| name | TEXT |  |
| token_prefix | TEXT |  |
| token_hash | TEXT |  |
| scope | TEXT | read | write |
| expires_at | INTEGER |  |
| revoked_at | INTEGER |  |
| revoked_by | INTEGER |  |

### project_templates

| 列 | 类型 | 说明 |
|---|---|---|
| id | INTEGER |  |
| code | TEXT | software_delivery | consulting | custom |
| name | TEXT |  |
| description | TEXT |  |
| updated_at | INTEGER |  |

### template_stages

| 列 | 类型 | 说明 |
|---|---|---|
| id | INTEGER |  |
| template_id | INTEGER |  |
| name | TEXT |  |
| sort_order | INTEGER |  |

### template_tasks

| 列 | 类型 | 说明 |
|---|---|---|
| id | INTEGER |  |
| template_id | INTEGER |  |
| stage_name | TEXT |  |
| title | TEXT |  |
| sort_order | INTEGER |  |

### projects

| 列 | 类型 | 说明 |
|---|---|---|
| id | INTEGER |  |
| name | TEXT |  |
| template_code | TEXT |  |
| status | TEXT | planning|active|paused|closed|cancelled |
| priority | TEXT | high|medium|low |
| lead_member_id | INTEGER |  |
| client_name | TEXT |  |
| plan_start_date | TEXT |  |
| plan_end_date | TEXT |  |
| actual_start_date | TEXT |  |
| actual_end_date | TEXT |  |
| closeout_summary | TEXT |  |
| updated_at | INTEGER |  |

### stages

| 列 | 类型 | 说明 |
|---|---|---|
| id | INTEGER |  |
| project_id | INTEGER |  |
| name | TEXT |  |
| sort_order | INTEGER |  |

### tasks

| 列 | 类型 | 说明 |
|---|---|---|
| id | INTEGER |  |
| project_id | INTEGER |  |
| stage_id | INTEGER |  |
| title | TEXT |  |
| responsible_member_id | INTEGER |  |
| status | TEXT | todo|doing|blocked|done|cancelled |
| plan_start_date | TEXT |  |
| plan_end_date | TEXT |  |
| actual_end_date | TEXT |  |
| source | TEXT | template|manual|extraction|suggestion |
| updated_at | INTEGER |  |
| depends_on_task_id | INTEGER |  |

### milestones

| 列 | 类型 | 说明 |
|---|---|---|
| id | INTEGER |  |
| project_id | INTEGER |  |
| name | TEXT |  |
| plan_date | TEXT |  |
| actual_date | TEXT |  |
| status | TEXT | planned|met|missed|cancelled |
| updated_at | INTEGER |  |

### dependencies

| 列 | 类型 | 说明 |
|---|---|---|
| id | INTEGER |  |
| task_id | INTEGER |  |
| depends_on_task_id | INTEGER |  |
| depends_on_member_id | INTEGER |  |
| note | TEXT |  |
| due_date | TEXT |  |
| status | TEXT | pending|satisfied|overdue |
| updated_at | INTEGER |  |

### channels

| 列 | 类型 | 说明 |
|---|---|---|
| id | INTEGER |  |
| platform | TEXT | feishu|wecom |
| group_key | TEXT |  |
| name | TEXT |  |
| channel_type | TEXT | dedicated|general |
| project_id | INTEGER |  |
| cursor | TEXT |  |
| last_pull_at | INTEGER |  |
| updated_at | INTEGER |  |

### project_events

| 列 | 类型 | 说明 |
|---|---|---|
| id | INTEGER |  |
| project_id | INTEGER |  |
| business_time | INTEGER | 消息发生/业务时间 |
| nature | TEXT | record|suggestion |
| event_type | TEXT | progress|risk|decision|blocker|schedule_change|status_change|suggestion|owner_change |
| summary | TEXT |  |
| raw_snapshot | TEXT |  |
| source_platform | TEXT | feishu|wecom|web|agent|brain |
| source_ref | TEXT |  |
| speaker_member_id | INTEGER |  |
| speaker_label | TEXT |  |
| confidence | REAL |  |
| status | TEXT | pending|effective|rejected|expired |
| target_task_id | INTEGER |  |
| target_field | TEXT | status|plan_end_date|responsible_member_id|priority|depends_on |
| target_value | TEXT |  |
| decided_by | INTEGER |  |
| decided_at | INTEGER |  |
| generated_by | TEXT | extraction|digest|agent|web|system |
| pushed_to | TEXT | JSON 数组：已推送成员 id |
| target_object | TEXT |  |

### unrouted_messages

| 列 | 类型 | 说明 |
|---|---|---|
| id | INTEGER |  |
| platform | TEXT |  |
| group_key | TEXT |  |
| business_time | INTEGER |  |
| speaker_label | TEXT |  |
| content | TEXT |  |
| status | TEXT | open|routed|discarded |
| routed_project_id | INTEGER |  |

### pushes

| 列 | 类型 | 说明 |
|---|---|---|
| id | INTEGER |  |
| push_type | TEXT | daily_report|digest|alert|test |
| recipient_member_id | INTEGER |  |
| related_project_id | INTEGER |  |
| title | TEXT |  |
| body | TEXT |  |
| channel_platform | TEXT |  |
| status | TEXT | sent|failed|skipped |

### settings

| 列 | 类型 | 说明 |
|---|---|---|
| key | TEXT |  |
| value | TEXT | JSON |
| updated_at | INTEGER |  |
| updated_by | INTEGER |  |

### audit_logs

| 列 | 类型 | 说明 |
|---|---|---|
| id | INTEGER |  |
| member_id | INTEGER |  |
| action | TEXT |  |
| object_type | TEXT |  |
| object_id | TEXT |  |
| detail | TEXT | JSON |

### migrations_meta

| 列 | 类型 | 说明 |
|---|---|---|
| name | TEXT |  |
| applied_at | INTEGER |  |

## 枚举（值 ↔ 中文 label，双向对齐）

- **memberRole**: admin=管理员、member=普通成员
- **memberStatus**: active=在职、offboarded=离职
- **projectStatus**: planning=待启动、active=进行中、paused=已暂停、closed=已结项、cancelled=已取消
- **priority**: high=高、medium=中、low=低
- **taskStatus**: todo=未开始、doing=进行中、blocked=被阻塞、done=已完成、cancelled=已取消
- **taskSource**: template=模板、manual=手动、extraction=抽取、suggestion=建议采纳
- **milestoneStatus**: planned=计划中、met=已达成、missed=已延误、cancelled=已取消
- **dependencyStatus**: pending=待满足、satisfied=已满足、overdue=已逾期
- **channelPlatform**: feishu=飞书、wecom=企业微信
- **channelType**: dedicated=专题渠道、general=通用群
- **eventNature**: record=记录型、suggestion=建议型
- **eventType**: progress=进展、risk=风险、decision=决策、blocker=阻塞、schedule_change=排期变更、status_change=状态变更、suggestion=建议、owner_change=责任人变更、priority_change=优先级变更
- **eventStatus**: pending=待确认、effective=已生效、rejected=已驳回、expired=已超时
- **eventGenerator**: extraction=IM 抽取、digest=梳理建议、agent=Agent 口述、web=页面操作、system=系统
- **pushType**: daily_report=日报、digest=梳理、alert=预警、test=测试
- **tokenScope**: read=只读、write=读写

<!--SCHEMA:END-->

## 里程碑建议示例（S4-3）

```sql
INSERT INTO project_events (project_id, business_time, created_at, nature, event_type, summary,
  source_platform, speaker_member_id, speaker_label, status, target_object, target_task_id,
  target_field, target_value, generated_by, pushed_to)
VALUES (<pid>, strftime('%s','now')*1000, strftime('%s','now')*1000, 'suggestion', 'schedule_change',
  '验收推迟到 2026-10-20', 'agent', <我>, '<我>', 'pending', 'milestone', <里程碑id>,
  'plan_date', '2026-10-20', 'agent', '[]');
```

用户在 Web 或 `POST /api/v1/events/<id>/confirm` 确认后生效。
