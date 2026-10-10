---
name: gb-pmo
version: 0.1.2
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
client.sh sql "SELECT id, name, status, priority FROM projects WHERE status = 'active'"
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
| 触发 | `POST /api/v1/agent/actions` | 白名单（触发类）：trigger_extraction / generate_project_digest / generate_person_digest / push_report |
| 配置（S17-10） | `POST /api/v1/agent/actions` | 白名单（配置类，**仅系统管理员 PAT**，成员 403）：upsert_channel / delete_channel / put_setting / reset_channel_cursor / delete_project |
| 任务清单起草（S17-9，v0.18） | `POST /api/v1/agent/actions` | `draft_task_list`（write scope 即可，成员可用）：LLM 产任务清单草稿，**不落库**，供立项/类型编辑参考 |
| 任务删除（S36，v0.40） | `POST /api/v1/agent/actions` | `delete_task`（write scope 即可，成员可用）：任务软删留痕；**删任务一律走此 action，不要手写 UPDATE/DELETE tasks** |
| AI 初始分配（S39，v0.42；S44，v0.45 异步化） | `POST /api/v1/agent/actions` | `draft_init_assignments` 启动草案作业返回 draftId（不落库）→ `GET /api/v1/agent/draft-init-assignments/:draftId?projectId=` 轮询（read scope 即可）→ `apply_init_assignments` 同事务批量落库（write scope；**信任边界限定例外**：初始化分配可直写，仅限该 action） |

### 配置类 action 参数（S17-10）

- `upsert_channel` `{platform: 'feishu'|'wecom', groupKey, name?, channelType: 'dedicated'|'general', projectId?}`（专题渠道必填 projectId；新建绑定 cursor=绑定时刻，首拉不回灌历史，改绑不重置游标——S3-6/v0.24）
- `delete_channel` `{id}`
- `put_setting` `{key, value}`（key ∈ thresholds / push / scheduler / llm / chat / im.feishu / im.wecom / backup；scheduler 含 cron 与每任务 enabled 开关（信息更新对齐/预警/日报/项目日历同步/数据库备份），非法值 400 并指明字段；llm 按类别分开存储：value 传 `{provider, apiKey?, baseUrl?, model?}`，只作用于该类别子配置、其他类别不覆盖，provider=当前生效类别，S17-11 v0.15；backup=S3 兼容备份存储 `{endpoint, region?, bucket, accessKeyId, secretAccessKey, prefix?, pathStyle?, keepCount?}`（阿里云 OSS / Cloudflare R2 / MinIO，定时快照异地备份，S34））
- `draft_task_list` `{name, description?}` → `{tasks: [...]}`（LLM 按名称+说明产任务清单草稿，**不落库**；v0.18 起成员 write scope 可用。原 create_template / draft_template_tasks 已随任务模板对象裁撤移除——项目类型内嵌任务清单（project_type_tasks），类型创建走提议确认、配置台维护）
- `reset_channel_cursor` `{channelId, days?}`（默认 7，1~90；重置后下次抽取回看 N 天，重放会追加新事件流）
- `delete_task` `{id}`（S36，v0.40：任务软删——行保留、`deleted_at` 落值、落 `task.delete` 审计；任务参考资料一并软删，更新记录与讨论面历史事件保留；已删任务从列表/盘点/未指派/逾期/指标等一切读侧退出，结项校验不计；任务不存在/已删 404，项目结项/取消 409）
- `delete_project` `{id}`（S37，v0.41：**项目硬删除**——物理抹除项目及任务/事件/里程碑/参考资料/渠道绑定/日历映射全部数据，**不可恢复**；仅系统管理员 PAT；任意状态可直接删；唯一痕迹=`project.hardDelete` 审计快照。与「取消」的业务终态留痕语义不同，抹数据才用；不要经 SQL 端点手写 DELETE projects——FK 约束会拒绝且绕开审计）
- `draft_init_assignments` `{projectId}` → `{draftId, status:'running'}`（S39/v0.42，S44/v0.45 异步化：LLM 读该类型的初始化提示词 `project_types.init_prompt` + 未完成任务清单 + 在职成员名册产草案，**不落库**；GLM 大输出要约 1~2 分钟，**必须轮询**）
- 草案轮询：`GET /api/v1/agent/draft-init-assignments/<draftId>?projectId=<id>`（read scope 即可）→ `{status:'running', elapsedMs}` / `{status:'done', assignments, warnings}`（assignments 覆盖全部未删未完成任务，遗漏任务=保持现状；非法任务/成员/日期行在 warnings）/ `{status:'error', message}`（错误以 200 载荷返回；作业 10 分钟有效期，过期 404 需重新发起。建议每 2~5s 轮询一次）
- `apply_init_assignments` `{projectId, assignments: [{taskId, responsibleMemberId|null, planStartDate|null, planEndDate|null}]}`（S39：每行=完整目标状态，单事务全量覆盖三字段；任务须属本项目未删除、成员须在职、日期真实日历日且止≥起——任一非法行整体 400 不落库；项目终态 409；落讨论面记录 + `task.initAssign` 审计。**初次分配推荐姿势**：先 draft 轮询拿草案给人过目（或按类型 init_prompt 自行推理），确认后调 apply）

## 工作守则（必须遵守）

1. **指标以 metrics 端点为准**（口径同源 dashboard）；明细与自由查询才用 SQL 端点。
2. **写 SQL 守则**：手动补 `updated_at`（epoch 毫秒）与审计需要的字段；软删不硬删（人员改 status='offboarded'，任务走 delete_task action 落 deleted_at，不要 DELETE）；403 不换字段重试；只改自己为责任人/牵头人的对象，跨人变更走建议。
3. **时间与时区（S19）**：日历日一律北京时区。SQL 中「今天」用「BJ_TODAY()」（可传 epoch 毫秒参数取该时刻的北京日）；不要写 date('now')/datetime('now')——那是 UTC 语义，凌晨会差一天，端点会 400 拒绝；时间戳一律 epoch 毫秒。
4. **LLM 信任边界**：口述更新一律 `INSERT INTO project_events (nature='suggestion', status='pending', ...)` 生成建议，等人在页面/接口确认；绝不直接 `UPDATE tasks` 改状态/日期/责任人。**唯一例外（S39/K21）**：初始化分配经 `apply_init_assignments` 直写（人显式发起、逐行校验、审计留痕）；其余任务变更仍走建议确认。另注意：v0.42 起任务责任人默认未指派（不再默认回填牵头人），新建/立项任务缺省 `responsible_member_id` 留 NULL。
5. 常用查询模式：
   - 「我本周的任务」：`SELECT t.id, t.title, t.plan_end_date, p.name FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.responsible_member_id=<我> AND t.status IN ('todo','doing') AND t.deleted_at IS NULL`
   - 「B 项目卡在哪」：看 project_events 最新 blocker/risk + 逾期未完任务（plan_end_date < BJ_TODAY() 且 status != 'done' 且 deleted_at IS NULL）。
   - **tasks 已删行（deleted_at 非空，S36）一切查询都要排除**（`AND deleted_at IS NULL`）——它们已退出任务面/指标/结项校验。
   - 任务状态固定三档：todo/doing/done（v0.6，无 blocked/cancelled）；任务相互独立，无前置依赖。
   - 「任务参考资料」（S23，SOP/知识库链接）：`SELECT title, url FROM task_refs WHERE task_id=<id> AND deleted_at IS NULL`；写入补 created_by/created_at，删除=软删（UPDATE task_refs SET deleted_at=<epoch毫秒>）；日报/预警/个人梳理推送会自动附带给责任人。
6. 建议事件的 target 字段组合：task → status/plan_start_date/plan_end_date/responsible_member_id；milestone → target_object='milestone' 且 plan_date。


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

### projects

| 列 | 类型 | 说明 |
|---|---|---|
| id | INTEGER |  |
| name | TEXT |  |
| template_code | TEXT |  |
| status | TEXT | active|closed|cancelled（S29 三态；planning/paused 已由 0016 归一，DEFAULT 为历史遗留，engine 始终显式赋值） |
| priority | TEXT | high|medium|low |
| lead_member_id | INTEGER |  |
| client_name | TEXT |  |
| plan_start_date | TEXT |  |
| plan_end_date | TEXT |  |
| actual_start_date | TEXT |  |
| actual_end_date | TEXT |  |
| closeout_summary | TEXT |  |
| updated_at | INTEGER |  |
| project_type_id | INTEGER |  |

### tasks

| 列 | 类型 | 说明 |
|---|---|---|
| id | INTEGER |  |
| project_id | INTEGER |  |
| title | TEXT |  |
| responsible_member_id | INTEGER |  |
| status | TEXT | todo|doing|blocked|done|cancelled |
| plan_start_date | TEXT |  |
| plan_end_date | TEXT |  |
| actual_end_date | TEXT |  |
| source | TEXT | template|manual|extraction|suggestion |
| updated_at | INTEGER |  |
| deleted_at | INTEGER |  |
| kind | TEXT |  |
| reminded_at | INTEGER |  |
| note | TEXT |  |

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
| error | TEXT |  |
| message_id | TEXT |  |
| group_key | TEXT |  |

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

### project_types

| 列 | 类型 | 说明 |
|---|---|---|
| id | INTEGER |  |
| code | TEXT | 预置编码（v0.30/S31）：lianmai_365 | consulting_1v1 | afternoon_tea | internal_training；旧占位 software_delivery/consulting/custom 已停用（0017） |
| name | TEXT |  |
| description | TEXT |  |
| status | TEXT | active | disabled |
| updated_at | INTEGER |  |
| init_prompt | TEXT |  |

### task_records

| 列 | 类型 | 说明 |
|---|---|---|
| id | INTEGER |  |
| task_id | INTEGER |  |
| member_id | INTEGER |  |
| content | TEXT |  |

### bot_commands

| 列 | 类型 | 说明 |
|---|---|---|
| id | INTEGER |  |
| message_id | TEXT |  |
| platform | TEXT |  |
| chat_id | TEXT |  |
| chat_type | TEXT |  |
| sender_open_id | TEXT |  |
| member_id | INTEGER |  |
| kind | TEXT |  |
| raw_text | TEXT |  |
| intent | TEXT |  |
| detail | TEXT |  |
| result | TEXT |  |
| llm_calls | INTEGER |  |
| duration_ms | INTEGER |  |

### bot_bind_codes

| 列 | 类型 | 说明 |
|---|---|---|
| id | INTEGER |  |
| member_id | INTEGER |  |
| code_hash | TEXT |  |
| expires_at | INTEGER |  |
| used_at | INTEGER |  |

### calendar_sync

| 列 | 类型 | 说明 |
|---|---|---|
| project_id | INTEGER |  |
| calendar_event_id | TEXT | 飞书 event_id（创建成功后写入） |
| content_hash | TEXT | 期望事件内容摘要（标题/描述/起止日），变则 patch |
| synced_at | INTEGER | 最近一次成功同步时刻（epoch 毫秒） |
| last_error | TEXT | 最近一次 patch 失败原因（create 失败尚无映射行，错误只在同步结果回显） |

### task_refs

| 列 | 类型 | 说明 |
|---|---|---|
| id | INTEGER |  |
| task_id | INTEGER |  |
| title | TEXT | 名称（如「部署 SOP」「验收知识库」） |
| url | TEXT | 链接（http/https；飞书文档/wiki 均可） |
| note | TEXT | 备注（可选：适用时机/范围） |
| deleted_at | INTEGER | 软删时刻（NULL=在用） |

### chat_sessions

| 列 | 类型 | 说明 |
|---|---|---|
| id | INTEGER |  |
| member_id | INTEGER |  |
| title | TEXT |  |
| updated_at | INTEGER | 最后活跃时刻（列表排序） |
| deleted_at | INTEGER | 软删时刻（NULL=在用） |

### chat_messages

| 列 | 类型 | 说明 |
|---|---|---|
| id | INTEGER |  |
| session_id | INTEGER |  |
| role | TEXT | user / assistant |
| content | TEXT |  |
| meta | TEXT | JSON：{result, llmCalls, queries, sql[], eventId?, writeKind?} |

### proposals

| 列 | 类型 | 说明 |
|---|---|---|
| id | INTEGER |  |
| kind | TEXT |  |
| payload | TEXT | JSON（解析后的提议载荷） |
| summary | TEXT | 人话摘要（确认卡/消息展示） |
| status | TEXT | pending / effective / rejected |
| proposed_by | INTEGER |  |
| decided_by | INTEGER |  |
| decided_at | INTEGER |  |

### project_type_tasks

| 列 | 类型 | 说明 |
|---|---|---|
| id | INTEGER |  |
| type_id | INTEGER |  |
| title | TEXT |  |
| sort_order | INTEGER |  |
| note | TEXT |  |

### bot_context_resets

| 列 | 类型 | 说明 |
|---|---|---|
| id | INTEGER |  |
| platform | TEXT |  |
| chat_id | TEXT |  |
| member_id | INTEGER |  |
| message_id | TEXT | 触发清空的那条消息（审计溯源） |
| cleared_at | INTEGER |  |

### project_type_task_refs

| 列 | 类型 | 说明 |
|---|---|---|
| id | INTEGER |  |
| type_task_id | INTEGER |  |
| title | TEXT | 名称（如「预热文案模板」「设备预检清单」） |
| url | TEXT | 链接（http/https；飞书文档/wiki 均可） |
| note | TEXT | 备注（可选：适用时机/范围） |
| sort_order | INTEGER |  |

### llm_calls

| 列 | 类型 | 说明 |
|---|---|---|
| id | INTEGER |  |
| purpose | TEXT | extraction|routing|digest|closeout|draft|init_assign|chat（自由文本约定值） |
| project_id | INTEGER | 关联项目（可空；对话面/个人梳理无单项目语义） |
| provider | TEXT | 生效类别（deepseek|glm-coding；fake 注入时为适配器名） |
| model | TEXT |  |
| prompt_tokens | INTEGER | 上游 usage 返回时记录，无则 NULL |
| completion_tokens | INTEGER |  |
| duration_ms | INTEGER |  |
| ok | INTEGER | 1 成功 / 0 失败（error 记摘要） |
| error | TEXT |  |

### im_buffer

| 列 | 类型 | 说明 |
|---|---|---|
| id | INTEGER |  |
| platform | TEXT |  |
| group_key | TEXT |  |
| message_id | TEXT | 全局去重键（网关重复投递/多源汇入幂等） |
| speaker_id | TEXT |  |
| speaker_label | TEXT |  |
| text | TEXT |  |
| ts | INTEGER | 消息时刻（epoch 毫秒） |
| consumed_at | INTEGER | 抽取排干时刻；NULL=待消费 |

## 枚举（值 ↔ 中文 label，双向对齐）

- **memberRole**: admin=系统管理员、member=成员
- **memberStatus**: active=在职、offboarded=离职
- **projectStatus**: active=进行中、closed=已结项、cancelled=已取消
- **projectTypeStatus**: active=启用、disabled=停用
- **priority**: high=高、medium=中、low=低
- **taskStatus**: todo=未开始、doing=进行中、done=完成
- **taskKind**: work=工作、reminder=纯提醒
- **taskSource**: template=模板、manual=手动、extraction=抽取、suggestion=建议采纳
- **milestoneStatus**: planned=计划中、met=已达成、missed=已延误、cancelled=已取消
- **channelPlatform**: feishu=飞书、wecom=企业微信
- **channelType**: dedicated=专题渠道、general=通用群
- **eventNature**: record=记录型、suggestion=建议型
- **eventType**: progress=进展、risk=风险、decision=决策、blocker=阻塞、finance=财务记录、schedule_change=排期变更、status_change=状态变更、suggestion=建议、owner_change=责任人变更、priority_change=优先级变更
- **eventStatus**: pending=待确认、effective=已生效、rejected=已驳回、expired=已超时
- **eventGenerator**: extraction=IM 抽取、digest=梳理建议、agent=Agent 口述、web=页面操作、system=系统
- **pushType**: daily_report=日报、digest=梳理、alert=预警、reminder=提醒、test=测试
- **tokenScope**: read=只读、write=读写
- **botCommandKind**: command=指令、card=卡片回调、bot_reply=机器人回复
- **botCommandResult**: replied=已回复、clarified=已追问、guidance=绑定引导、bound=已绑定、card_sent=已发确认卡、confirmed=已确认生效、rejected=已驳回、refused_permission=权限不足、refused_quota=超出限额、refused_external=外部群拒答、refused_unregistered=未登记群拒答、ignored_unbound=未绑定忽略、ignored_dedup=重复忽略、refused_not_mentioned=未@机器人忽略、no_llm=LLM 未配置、error=错误

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
