// S76（v0.89，design.md K76）— 结项自动标记专题群群名【已结项】。
// 与 K73 知识页标题标记（engine/wiki.js）同族：同三入口接入（web 结项 / 提议确认卡 / 机器人一条链）、
// 尽力而为不阻断、幂等可重入、互不影响。只标记结项（closed），取消不标记（由调用方口径保证）。

import { audit } from './auth.js'
import { getSetting } from './settings.js'
import { getChat, renameChat } from '../brain/connectors/feishu.js'

export const CHAT_CLOSED_MARK = '【已结项】'

function feishuCfg(db) {
  const cfg = getSetting(db, 'im.feishu')
  if (!cfg?.appId || !cfg?.appSecret) {
    throw Object.assign(new Error('飞书凭证未配置（配置台「外部依赖→飞书」填 appId/appSecret）'), { statusCode: 400 })
  }
  return cfg
}

/** 项目的飞书专题群（dedicated，可多群；general 通用群多项目共用，不标记）。 */
export function dedicatedFeishuChannels(db, projectId) {
  return db.prepare(
    "SELECT id, group_key AS groupKey, name FROM channels WHERE project_id = ? AND platform = 'feishu' AND channel_type = 'dedicated'",
  ).all(Number(projectId))
}

/**
 * 结项标记：把项目每个飞书专题群的群名追加「【已结项】」。取群**当前**名（channels.name 是
 * 绑定时刻快照，可能被别人改过——不回写旧值），PUT 改名，同步绑定行 name + audit 留痕。
 * 幂等：群名已带标记时跳过不重复追加。多群逐个处理、单群失败不影响其余（failures 汇总）。
 * 抛错（如凭证未配）由调用方兜（chatCloseMarkNotice / 各结项入口）——标记是结项的附带动作而非门槛（K76）。
 * 返回 { marked, names, failures }；marked=false 且无 failures 即无事可做（未绑群/全部已带标记）。
 */
export async function markProjectChatsClosed(db, projectId, by) {
  const pid = Number(projectId)
  const chans = dedicatedFeishuChannels(db, pid)
  if (!chans.length) return { marked: false, names: [], failures: [] } // 未绑闸在飞书凭证检查之前：无绑定零请求
  const cfg = feishuCfg(db)
  const names = []
  const failures = []
  for (const ch of chans) {
    try {
      const chat = await getChat(cfg, ch.groupKey)
      const name = String(chat?.name || '').trim()
      if (!name) {
        failures.push({ group: ch.name || ch.groupKey, error: '群名为空' })
        continue
      }
      if (name.endsWith(CHAT_CLOSED_MARK)) continue
      const newName = `${name}${CHAT_CLOSED_MARK}`
      await renameChat(cfg, ch.groupKey, newName)
      db.prepare('UPDATE channels SET name = ?, updated_at = ? WHERE id = ?').run(newName, Date.now(), ch.id)
      audit(db, { memberId: by, action: 'project.chat.close_mark', objectType: 'project', objectId: pid, detail: { groupKey: ch.groupKey, name: newName } })
      names.push(newName)
    } catch (e) {
      failures.push({ group: ch.name || ch.groupKey, error: e.message })
    }
  }
  return { marked: names.length > 0, names, failures }
}

/**
 * 结项群名标记结果 → 人话提示（三个结项入口共用；K76）：
 * 未绑群/全部已带标记 → null（回执与响应里无需播报）；失败 → 中文提示（不抛出，结项不受阻）。
 */
export async function chatCloseMarkNotice(db, projectId, by) {
  try {
    const r = await markProjectChatsClosed(db, projectId, by)
    if (r.failures.length) {
      return `专题群名标记失败：${r.failures.map((f) => `${f.group}（${f.error}）`).join('；')}（项目已结项，可稍后在飞书手动改群名）`
    }
    if (!r.marked) return null
    return `专题群名已标记：${r.names.join('、')}`
  } catch (e) {
    return `专题群名标记失败：${e.message}（项目已结项，可稍后在飞书手动改群名）`
  }
}
