// 大脑·纯提醒（S57，v0.62，design.md K40）：kind='reminder' 任务到期一次性推送——责任人私聊 + 项目专题群，
// 发完即自动完成（reminded_at 幂等锚点），不进逾期追踪口径（指标/健康分/简报盘子均只认 kind='work'）。
// 复用预警巡检周期（alertCron，15 分钟粒度足够；提醒是日级语义）；零 LLM 成本，纯确定性。
// 发送时点门槛：提醒日当天北京时间过 reminder.fireAfterHour（默认 09:00）后首个周期触发——凌晨不推。
// v0.63（K41）：私聊与群推送均附交互卡片（buildReminderCard，wathet ⏰），卡片失败降级 post/text 补发。

import { dueReminders, completeReminder } from '../engine/tasks.js'
import { getSetting } from '../engine/settings.js'
import { bjDayStartMs } from '../db/time.js'
import { notifyMember, notifyProjectChannel } from './push.js'
import { buildReminderCard } from './bot/cards.js'

/** 北京时刻的小时数（0~23；与 db/time.js 同源推算，不依赖服务器时区）。 */
function bjHour(atMs) {
  return Math.floor((atMs - bjDayStartMs(atMs)) / 3_600_000)
}

export async function evaluateReminders(db, { send, now = Date.now } = {}) {
  const nowMs = now()
  const { fireAfterHour = 9 } = getSetting(db, 'reminder')
  if (bjHour(nowMs) < fireAfterHour) return { reminders: [] } // 门槛内不推（凌晨静默）

  const reminders = []
  for (const t of dueReminders(db)) {
    const ownerActive = t.ownerId != null && t.ownerStatus === 'active'
    const payload = {
      pushType: 'reminder', projectId: t.projectId,
      title: `⏰ 提醒：${t.title}`,
      body: `「**${t.projectName}**」的纯提醒事项「**${t.title}**」提醒日（${t.planEndDate}）到了` +
        `${ownerActive ? `，责任人 **${t.responsibleName}**` : ''}。一次性送达，任务已自动标记完成（不追踪状态）。` +
        `${t.note ? `\n备注：${t.note}` : ''}`, // S58：备注「怎么干」随提醒带上
      card: buildReminderCard({
        title: t.title, projectName: t.projectName, planEndDate: t.planEndDate,
        responsibleName: ownerActive ? t.responsibleName : null, note: t.note,
      }),
    }
    // 责任人私聊（未指派/离职跳过——群侧兜底触达）
    if (ownerActive) {
      await notifyMember(db, { id: t.ownerId, name: t.responsibleName, feishuId: t.feishuId, wecomId: t.wecomId }, payload, { send })
    }
    // 项目全部绑定专题群
    const groups = await notifyProjectChannel(db, t.projectId, payload, { send })
    // 无论推送成败：置完成落幂等锚点（pushes 行已如实记录 sent/failed/skipped，通知语义不重试）
    completeReminder(db, t, { note: `${ownerActive ? '责任人私聊' : '责任人不可达'} · 专题群 ${groups.length} 个` })
    reminders.push({ taskId: t.id, projectId: t.projectId, title: t.title, groups: groups.length })
  }
  return { reminders }
}
