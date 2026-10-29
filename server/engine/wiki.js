// S61（v0.66，design.md K45）：项目 ↔ 飞书知识库页面绑定 + 机器人写页面。
// 绑定：贴 wiki 链接解析 node_token，或在指定页面下新建子页；一项目绑一页。
// 写入：用户「记一下」类指令把内容按类型分小节追加到绑定页面（docx block）。
// 信任边界：对话面用户明确指令直生效（K25）；权限硬前提——机器人须先被加进知识库。

import { camelizeRow } from '../db/index.mjs'
import { audit } from './auth.js'
import { label } from './enums.js'
import { getSetting } from './settings.js'
import { getWikiNode, createWikiNode, renameWikiNode, appendDocBlocks } from '../brain/connectors/feishu.js'

/** 从 wiki 链接解析 node_token（/wiki/<token>，容忍查询串/锚点/尾部斜杠）。 */
export function parseWikiNodeToken(url) {
  const m = String(url || '').match(/\/wiki\/([A-Za-z0-9_-]+)/)
  return m ? m[1] : null
}

/** 读项目绑定（无绑定返回 null）。 */
export function getProjectWiki(db, projectId) {
  const row = db.prepare('SELECT * FROM project_wiki_bindings WHERE project_id = ?').get(Number(projectId))
  return row ? camelizeRow(row) : null
}

function feishuCfg(db) {
  const cfg = getSetting(db, 'im.feishu')
  if (!cfg?.appId || !cfg?.appSecret) {
    throw Object.assign(new Error('飞书凭证未配置（配置台「外部依赖→飞书」填 appId/appSecret）'), { statusCode: 400 })
  }
  return cfg
}

/**
 * 绑定项目到 wiki 页面。两条路径：
 *  ① { wikiUrl }      —— 贴链接绑定已有页面：解析 node_token → get_node 验证 + 换 obj_token。
 *  ② { parentWikiUrl|parentNodeToken, newTitle } —— 在指定页面下新建 docx 子页并绑定。
 * 权限：admin 或项目 lead（复用 canManageChannel 同口径，路由/bot 侧已校验，此处兜底）。
 */
export async function bindProjectWiki(db, projectId, { wikiUrl, parentWikiUrl, parentNodeToken, newTitle } = {}, by) {
  const pid = Number(projectId)
  const project = db.prepare('SELECT id, name, status FROM projects WHERE id = ?').get(pid)
  if (!project) throw Object.assign(new Error('项目不存在'), { statusCode: 404 })
  if (project.status === 'closed' || project.status === 'cancelled') {
    throw Object.assign(new Error('项目已结项/取消，不可绑定知识库'), { statusCode: 409 })
  }
  const cfg = feishuCfg(db)

  let node
  if (wikiUrl) {
    // 路径①：已有页面
    const nodeToken = parseWikiNodeToken(wikiUrl)
    if (!nodeToken) throw Object.assign(new Error('无法从链接解析 wiki 页面（应为 https://xxx.feishu.cn/wiki/<token>）'), { statusCode: 400 })
    node = await getWikiNode(cfg, nodeToken)
    if (!node) throw Object.assign(new Error('wiki 页面不存在或机器人无权访问'), { statusCode: 404 })
  } else {
    // 路径②：指定页面下新建子页
    const pToken = parentNodeToken || parseWikiNodeToken(parentWikiUrl)
    if (!pToken) throw Object.assign(new Error('新建子页须给父页面（parentWikiUrl 或 parentNodeToken）'), { statusCode: 400 })
    if (!newTitle || !String(newTitle).trim()) throw Object.assign(new Error('新建子页须给标题 newTitle'), { statusCode: 400 })
    const parent = await getWikiNode(cfg, pToken)
    if (!parent) throw Object.assign(new Error('父页面不存在或机器人无权访问'), { statusCode: 404 })
    node = await createWikiNode(cfg, parent.spaceId, { parentNodeToken: pToken, title: String(newTitle).trim() })
    if (!node) throw Object.assign(new Error('新建子页失败'), { statusCode: 502 })
  }
  if (node.objType !== 'docx') {
    throw Object.assign(new Error(`仅支持绑定文档页（docx），当前页面类型为 ${node.objType}`), { statusCode: 400 })
  }

  const now = Date.now()
  db.prepare(
    `INSERT INTO project_wiki_bindings (project_id, space_id, node_token, obj_token, title, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET space_id = excluded.space_id, node_token = excluded.node_token,
       obj_token = excluded.obj_token, title = excluded.title, updated_at = excluded.updated_at`
  ).run(pid, node.spaceId, node.nodeToken, node.objToken, node.title || null, by ?? null, now, now)
  audit(db, { memberId: by, action: 'project.wiki.bind', objectType: 'project', objectId: pid, detail: { nodeToken: node.nodeToken, title: node.title } })
  return getProjectWiki(db, pid)
}

/** 读默认父页面 node_token（settings.wiki.defaultParentUrl → parseWikiNodeToken；未配/非法返回 null）。 */
export function getDefaultParentToken(db) {
  const url = getSetting(db, 'wiki')?.defaultParentUrl
  return url ? parseWikiNodeToken(url) : null
}

/** 拼 wiki 页面可点链接（回执用）；host 从绑定来源 URL 取，兜底 feishu.cn。 */
export function wikiPageUrl(nodeToken, host = 'feishu.cn') {
  return `https://${host}/wiki/${nodeToken}`
}

/** eventType → 页面小节标题（按类型分小节）。 */
const SECTION_BY_TYPE = { progress: '进展', decision: '决策', risk: '风险', blocker: '阻塞' }
const sectionTitle = (eventType) => SECTION_BY_TYPE[eventType] || '记录'

/**
 * 把一条内容追加到项目绑定的 wiki 页面：按 eventType 映射小节标题，
 * 追加 [heading2 小节 + text 内容] 两个 block。未绑定/权限不足抛明确中文错误。
 * 返回 { title, section, url }（url=页面可点链接，回执带跳转，S62）。
 */
export async function recordToWiki(db, projectId, { eventType = 'progress', summary } = {}, by) {
  const pid = Number(projectId)
  const binding = getProjectWiki(db, pid)
  if (!binding) throw Object.assign(new Error('该项目还未绑定知识库页面。绑定方式：① 把 wiki 页面链接发给我（「绑定这个页面 https://…/wiki/…」）；② 或在 web 项目详情页「知识库」卡绑定。绑定后再说「记一下…」即可写入。'), { statusCode: 400 })
  const text = String(summary || '').trim()
  if (!text) throw Object.assign(new Error('记录内容不能为空'), { statusCode: 400 })
  const cfg = feishuCfg(db)

  const blocks = [
    { block_type: 4, heading2: { elements: [{ text_run: { content: sectionTitle(eventType) } }] } }, // block_type 4 = heading2
    { block_type: 2, text: { elements: [{ text_run: { content: text } }] } }, // block_type 2 = text
  ]
  await appendDocBlocks(cfg, binding.objToken, blocks)
  audit(db, { memberId: by, action: 'project.wiki.record', objectType: 'project', objectId: pid, detail: { eventType, nodeToken: binding.nodeToken } })
  return { title: binding.title, section: sectionTitle(eventType), eventTypeLabel: label('eventType', eventType), url: wikiPageUrl(binding.nodeToken) }
}

// —— S61-7 / S29-5（v0.87.2，K73）：结项自动标记知识页标题【已结项】——尽力而为、幂等可重入 ——

export const WIKI_CLOSED_MARK = '【已结项】'

/**
 * 结项标记：把绑定页面标题追加「【已结项】」。取节点**当前**标题（绑定行 title 是绑定时刻快照，
 * 可能被别人改过——不回写旧值），PATCH wiki node 改树里显示名（不动 docx 内文标题块），
 * 同步绑定行 title + audit 留痕。幂等：标题已带标记时跳过不重复追加。
 * 抛错由调用方兜（wikiCloseMarkNotice / 各结项入口）——标记是结项的附带动作而非门槛（K73）。
 * 返回 { marked: true, title } | { marked: false, reason: 'unbound' | 'already' | 'no-title' }。
 */
export async function markWikiClosed(db, projectId, by) {
  const pid = Number(projectId)
  const binding = getProjectWiki(db, pid)
  if (!binding) return { marked: false, reason: 'unbound' } // 未绑定闸在飞书凭证检查之前：无绑定零请求
  const cfg = feishuCfg(db)
  const node = await getWikiNode(cfg, binding.nodeToken)
  const title = String(node?.title || binding.title || '').trim()
  if (!title) return { marked: false, reason: 'no-title' }
  if (title.endsWith(WIKI_CLOSED_MARK)) return { marked: false, reason: 'already' }
  const newTitle = `${title}${WIKI_CLOSED_MARK}`
  await renameWikiNode(cfg, binding.spaceId, binding.nodeToken, newTitle)
  db.prepare('UPDATE project_wiki_bindings SET title = ?, updated_at = ? WHERE project_id = ?').run(newTitle, Date.now(), pid)
  audit(db, { memberId: by, action: 'project.wiki.close_mark', objectType: 'project', objectId: pid, detail: { nodeToken: binding.nodeToken, title: newTitle } })
  return { marked: true, title: newTitle }
}

/**
 * 结项标记结果 → 人话提示（三个结项入口共用；K73）：
 * 未绑定/无标题/已带标记 → null（回执与响应里无需播报）；失败 → 中文提示（不抛出，结项不受阻）。
 */
export async function wikiCloseMarkNotice(db, projectId, by) {
  try {
    const r = await markWikiClosed(db, projectId, by)
    if (r.marked) return `知识页标题已标记：${r.title}`
    return null // unbound / already / no-title：无事可说
  } catch (e) {
    return `知识页标题标记失败：${e.message}（项目已结项，可稍后在飞书手动改页面标题）`
  }
}
