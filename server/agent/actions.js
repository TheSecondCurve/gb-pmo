// action 白名单注册表（K3；K9 起 HTTP Agent 端点与 S20 机器人 trigger 工具共用）。
// 新增动作 = 在此加一项，两个入口天然获得白名单/adminOnly/审计语义。
// ctx: { db, member, llm }；llm 为已解析的适配器（或 undefined 走 settings 动态解析）。
import * as tasks from '../engine/tasks.js'
import { setSetting } from '../engine/settings.js'

export const ACTIONS = {
  // 触发类：write scope 即可（成员可用；机器人同样开放）
  trigger_extraction: {
    run: async (params, ctx) => (await import('../brain/extract.js')).runExtraction(ctx.db, params, { llm: ctx.llm ?? undefined }),
  },
  generate_project_digest: {
    run: async (params, ctx) =>
      (await import('../brain/digest.js')).projectDigest(ctx.db, Number(params.projectId), { llm: ctx.llm ?? undefined }),
  },
  generate_person_digest: {
    run: async (params, ctx) =>
      (await import('../brain/digest.js')).personDigest(ctx.db, Number(params.memberId ?? ctx.member.id), { llm: ctx.llm ?? undefined }),
  },
  push_report: {
    run: async (params, ctx) => (await import('../brain/report.js')).dailyReport(ctx.db, { llm: ctx.llm ?? undefined, force: true }),
  },

  // 配置类（S17-10）：与 web 配置台同构（复用 engine 校验与审计），仅系统管理员
  upsert_channel: {
    adminOnly: true,
    run: async (params, ctx) => tasks.upsertChannel(ctx.db, params, ctx.member.id),
  },
  delete_channel: {
    adminOnly: true,
    run: async (params, ctx) => tasks.deleteChannel(ctx.db, Number(params.id), ctx.member.id) || { ok: true },
  },
  put_setting: {
    adminOnly: true,
    run: async (params, ctx) => setSetting(ctx.db, params.key, params.value, ctx.member.id),
  },
  // 任务清单 AI 起草（S17-9，v0.18 更名并放开到 write scope）：供立项/类型编辑取草稿，不落库
  draft_task_list: {
    run: async (params, ctx) =>
      (await import('../brain/templates.js')).draftTaskList(ctx.db, params, { llm: ctx.llm ?? undefined }),
  },
  reset_channel_cursor: {
    adminOnly: true,
    run: async (params, ctx) => tasks.resetChannelCursor(ctx.db, Number(params.channelId), { days: params.days }, ctx.member.id),
  },
}

/** 机器人开放的动作子集（S20）：触发类全员，配置类走 web/Agent 通道，不经机器人。 */
export const BOT_ACTIONS = ['trigger_extraction', 'generate_project_digest', 'generate_person_digest', 'push_report']
