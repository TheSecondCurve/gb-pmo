// S63（v0.68，design.md K48）：项目群全量汇总归档知识库——
// 人工触发（web 知识库卡「生成项目汇总」/ S73 机器人 @触发）→ 全量回读绑定专题群历史（不挪游标/不进 im_buffer/
// 不产事件，与 S3-6 增量抽取不回灌是互补口径）→ 关键时间线（事件流 record/effective + 里程碑 + 任务完成，确定性）
// + LLM 分块产重要内容/群内金句 → 写入绑定页面最后一个「项目汇总」章节（不存在则文末新建）；生成区首尾标记行包裹，
// 重跑按锚点幂等替换。台账 wiki_archive_runs（migration 0029）。
// 图片/附件归档（v0.85.1 两段式）：生成区以「图注 + 空占位块」写入 → 占位块建 media token 直塞创建载荷是非法的
// （1770001）——素材以块 id 为 parent 上传，再 batch_update replace_image/replace_file 换入 token。
// 信任边界：人工明确指令触发的记录型外写，直生效不进确认卡（K25）；不改系统内业务数据。

import { camelizeRow, camelizeRows } from '../db/index.mjs'
import { bjStamp, today } from '../db/time.js'
import { audit } from './auth.js'
import { label } from './enums.js'
import { getSetting } from './settings.js'
import { getProjectWiki, wikiPageUrl } from './wiki.js'
import { getLlm, parseJsonLoose } from '../brain/llm.js'
import { mapSpeaker } from '../brain/extract.js'
import {
  fetchChatHistory, listDocRootBlocks, listBlockChildren, insertDocBlocks, deleteDocChildren,
  batchUpdateDocBlocks, downloadChatImage, uploadDocImage, downloadChatFile, uploadDocFile,
} from '../brain/connectors/feishu.js'

const MAX_MESSAGES = 20000 // 量护栏：超出取最近（连接器降序分页保证）并标 truncated
const CHUNK_CHARS = 12000 // LLM 分块字数（消息行累计）
const MAX_CHUNKS = 24 // 超出均匀抽样（成本护栏）
const MAX_HIGHLIGHTS = 8
const MAX_QUOTES = 10
const MAX_IMAGES = 30
const MAX_FILES = 30
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024 // <20MB 小文件归档（含等于 20MB：fly docx_file 上限）
const MAX_TIMELINE = 60
const CHAPTER_TITLE = '项目汇总'
const START_PREFIX = '🤖 项目大脑汇总' // 生成区首标记（幂等扫描前缀）
const END_MARKER = '— 项目大脑汇总结束 —' // 生成区尾标记

/** 北京时刻「YYYY-MM-DD HH:mm」（经 bjStamp 固定 +8，不依赖 tzdata——K16 口径）。 */
function fmtMinute(ms) {
  const s = bjStamp(ms)
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)} ${s.slice(9, 11)}:${s.slice(11, 13)}`
}

/** 消息行时间前缀「MM-DD HH:mm」（同源 bjStamp）。 */
function fmtMsg(ms) {
  const s = bjStamp(ms)
  return `${s.slice(4, 6)}-${s.slice(6, 8)} ${s.slice(9, 11)}:${s.slice(11, 13)}`
}

// —— docx block 构造（block_type：2 text / 4 heading2 / 5 heading3 / 12 bullet / 23 file / 27 image）——
const textBlock = (content) => ({ block_type: 2, text: { elements: [{ text_run: { content } }] } })
const heading2 = (content) => ({ block_type: 4, heading2: { elements: [{ text_run: { content } }] } })
const heading3 = (content) => ({ block_type: 5, heading3: { elements: [{ text_run: { content } }] } })
const bullet = (content) => ({ block_type: 12, bullet: { elements: [{ text_run: { content } }] } })
// v0.85.1（官方口径实证，K69）：children 创建载荷**不能**携带素材 token（image:{token}/file:{token}
// 一律 1770001 invalid param 整包拒掉）——必须先建空占位块，素材以「块 id」为 parent_node 上传，
// 再 batch_update replace_image/replace_file 换入 token（fillMediaBlocks 两段式第二步）。
// file 占位块创建时飞书自动包一层 view(33) 块：根级是 view、真附件块(23)是 view 的子块。
// 文件名由紧邻的图注文本块承担（collectFileItems 写「日期 说话人 · 文件名」）。
const imagePlaceholder = () => ({ block_type: 27, image: {} })
const filePlaceholder = () => ({ block_type: 23, file: {} })

/** 读 block 纯文本（章节标题匹配/标记行扫描共用）。 */
function blockText(b) {
  const c = b.text || b.heading1 || b.heading2 || b.heading3 || b.bullet
  return (c?.elements || []).map((e) => e.text_run?.content || '').join('')
}

const getRun = (db, runId) => camelizeRow(db.prepare('SELECT * FROM wiki_archive_runs WHERE id = ?').get(Number(runId)))

/** 项目最近一次汇总台账（前端轮询用；无则 null）。 */
export function getLatestWikiArchiveRun(db, projectId) {
  const row = db.prepare('SELECT * FROM wiki_archive_runs WHERE project_id = ? ORDER BY id DESC LIMIT 1').get(Number(projectId))
  return row ? camelizeRow(row) : null
}

/**
 * 触发一次汇总归档：前置校验（绑定页面/专题群/无运行中）→ 落 running 台账 → 异步执行。
 * defer=false 时同步执行完再返回（测试与内部调用用）；路由默认异步，POST 立即返回 running。
 * onDone(run)（S73，v0.85）：终态（done|failed）后台账行回调（机器人入口推终态回执用），尽力而为——
 * 回调抛错不影响台账终态，也不重试。
 */
export async function startWikiArchive(db, projectId, by, { llm, defer = true, onDone } = {}) {
  const pid = Number(projectId)
  const project = db.prepare('SELECT id, name, status, kind FROM projects WHERE id = ?').get(pid)
  if (!project) throw Object.assign(new Error('项目不存在'), { statusCode: 404 })
  // S72（v0.84，K68）：常态项目关闭全量归档——长生命周期群恒定触顶量护栏且 truncated 截丢早期内容，
  // 产出为交付叙事；执行历史看周视图与打卡记录。守卫只挡新触发，存量 running 与已生成内容不动。
  if (project.kind === 'routine') {
    throw Object.assign(
      new Error('常态项目不支持全量汇总归档：群消息为日常执行噪音且量大（归档口径不适用）——执行历史请看项目周视图与打卡记录（S72）'),
      { statusCode: 400 }
    )
  }
  if (!getProjectWiki(db, pid)) {
    throw Object.assign(new Error('该项目还未绑定知识库页面——先在项目详情页「知识库」卡绑定，再生成项目汇总'), { statusCode: 400 })
  }
  const channel = db.prepare("SELECT * FROM channels WHERE project_id = ? AND platform = 'feishu' AND channel_type = 'dedicated' ORDER BY id LIMIT 1").get(pid)
  if (!channel) throw Object.assign(new Error('该项目未绑定飞书专题群——没有可回读的群消息来源'), { statusCode: 400 })
  const running = db.prepare("SELECT id FROM wiki_archive_runs WHERE project_id = ? AND status = 'running' LIMIT 1").get(pid)
  if (running) throw Object.assign(new Error('该项目已有正在运行的汇总任务，等它完成后再触发'), { statusCode: 409 })
  const info = db.prepare("INSERT INTO wiki_archive_runs (project_id, status, stage, created_by, created_at) VALUES (?, 'running', 'fetch', ?, ?)").run(pid, by ?? null, Date.now())
  const runId = Number(info.lastInsertRowid)
  audit(db, { memberId: by, action: 'project.wiki.archive', objectType: 'project', objectId: pid, detail: { runId } })
  if (defer) {
    setImmediate(() => { void executeWikiArchive(db, runId, { llm, onDone }) }) // 失败在 execute 内部落 failed，不抛未捕获
  } else {
    await executeWikiArchive(db, runId, { llm, onDone })
  }
  return getRun(db, runId)
}

/** 执行一次汇总：回读 → 汇总 → 图片 → 写入；任何失败落 failed + 中文错误（不外抛）。 */
export async function executeWikiArchive(db, runId, { llm: llmOverride, onDone } = {}) {
  const run = getRun(db, runId)
  if (!run) throw Object.assign(new Error('汇总任务不存在'), { statusCode: 404 })
  const pid = run.projectId
  const patch = (fields) => {
    const cols = Object.keys(fields).map((k) => `${k} = ?`).join(', ')
    db.prepare(`UPDATE wiki_archive_runs SET ${cols} WHERE id = ?`).run(...Object.values(fields), runId)
  }
  try {
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(pid)
    const binding = getProjectWiki(db, pid)
    const channel = db.prepare("SELECT * FROM channels WHERE project_id = ? AND platform = 'feishu' AND channel_type = 'dedicated' ORDER BY id LIMIT 1").get(pid)
    const cfg = getSetting(db, 'im.feishu')
    if (!cfg?.appId || !cfg?.appSecret) {
      throw Object.assign(new Error('飞书凭证未配置（配置台「外部依赖→飞书」填 appId/appSecret）'), { statusCode: 400 })
    }

    // ① 全量回读：自项目创建时刻起（K48：人明确要的一次性归档，不挪游标/不进缓冲/不产事件）
    const startSec = Math.floor(Number(project.created_at) / 1000)
    const { messages, truncated: fetchTruncated } = await fetchChatHistory(cfg, channel.group_key, { startSec, maxMessages: MAX_MESSAGES })
    const speakerName = (m) => mapSpeaker(db, 'feishu', m.speakerId)?.name ?? '未识别'
    const lines = []
    const images = []
    const files = []
    for (const m of messages) {
      if (m.speakerType === 'app') continue // 机器人自身消息过滤
      if (m.msgType === 'image') {
        if (m.imageKey) images.push(m)
        continue
      }
      if (m.msgType === 'file') {
        if (m.fileKey) files.push(m)
        continue
      }
      const text = String(m.text || '').replace(/\s+/g, ' ').trim()
      if (text.length < 2) continue // 空文本/单字语气不进汇总
      lines.push(`[${fmtMsg(m.ts)}] ${speakerName(m)}: ${text.slice(0, 500)}`)
    }
    patch({ stage: 'summarize', message_count: lines.length })

    // ② 汇总：时间线确定性（事件流+里程碑+任务完成）；LLM 分块产重要内容/金句（缺席走降级）
    const timeline = buildTimeline(db, pid)
    const llm = getLlm(db, llmOverride, { purpose: 'wiki_archive', projectId: pid })
    const summarized = await summarize(db, llm, project.name, lines)
    const highlights = summarized?.highlights ?? fallbackHighlights(db, pid)
    const quotes = summarized?.quotes ?? []
    const quotesNote = llm ? '（本群没有可摘录的金句）' : '（未配置 LLM，金句未提取——配置后重新生成即可）'
    const truncated = fetchTruncated || Boolean(summarized?.sampled)
    patch({ stage: 'images', chunk_count: summarized?.chunkCount ?? 0, quotes_count: quotes.length, truncated: truncated ? 1 : 0 })

    // ③ 群内图片：下载即可（单张失败跳过不阻塞）；上传与挂块在 ④ 写入后两段式完成（v0.85.1）
    const imgItems = await collectImageItems(db, cfg, images)
    patch({ stage: 'files' })

    // ③b 群内附件：<20MB 文件下载（超限/失败跳过并记录原因）；上传与挂块同样后置
    const { items: fileItems, skipped: skippedFiles } = await collectFileItems(db, cfg, files)
    patch({ stage: 'write' })

    // ④ 写入：定位最后一个「项目汇总」章节末尾；无则文末新建；重跑按锚点幂等替换。
    // 媒体块以空占位进文档，写入完成后 fillMediaBlocks 逐项「挂块上传 + replace 换 token」。
    const marker = `${START_PREFIX} · 生成于 ${fmtMinute(Date.now())} · 回读群消息 ${lines.length} 条（自项目创建起全量）${truncated ? '（超上限已截断/抽样，仅含最近部分）' : ''}`
    const { blocks, mediaPlan } = buildArchiveBlocks({ marker, timeline, highlights, quotes, quotesNote, imgItems, imageTotal: images.length, fileItems, fileTotal: files.length, skippedFiles })
    const created = await writeArchiveSection(db, cfg, pid, binding.objToken, blocks)
    const { imageDone, fileDone, postSkipped } = await fillMediaBlocks(cfg, binding.objToken, created, mediaPlan)
    patch({
      status: 'done', stage: 'done', first_block_id: created[0]?.block_id ?? null,
      image_count: imageDone, file_count: fileDone,
      skipped_files: JSON.stringify([...skippedFiles, ...postSkipped]).slice(0, 500),
      page_url: wikiPageUrl(binding.nodeToken), finished_at: Date.now(),
    })
  } catch (e) {
    patch({ status: 'failed', error: String(e?.message || e).slice(0, 500), finished_at: Date.now() })
  }
  const finalRun = getRun(db, runId)
  if (typeof onDone === 'function') {
    try { onDone(finalRun) } catch { /* 尽力而为：回调失败不影响台账终态 */ }
  }
  return finalRun
}

/** 关键时间线：事件流（record/effective）+ 里程碑 + 任务完成，按日升序（确定性，LLM 缺席也完整）。 */
function buildTimeline(db, pid) {
  const rows = []
  const events = camelizeRows(
    db.prepare("SELECT event_type, summary, business_time FROM project_events WHERE project_id = ? AND nature = 'record' AND status = 'effective' ORDER BY business_time").all(pid)
  )
  for (const e of events) rows.push({ day: today(e.businessTime), text: `${label('eventType', e.eventType)}：${e.summary}` })
  for (const m of camelizeRows(db.prepare('SELECT name, plan_date, actual_date, status FROM milestones WHERE project_id = ?').all(pid))) {
    const day = m.actualDate || m.planDate
    if (day) rows.push({ day, text: `里程碑：${m.name}${m.status === 'met' ? '（达成）' : ''}` })
  }
  for (const t of camelizeRows(db.prepare("SELECT title, updated_at FROM tasks WHERE project_id = ? AND status = 'done' AND deleted_at IS NULL").all(pid))) {
    rows.push({ day: today(t.updatedAt), text: `✅ 完成任务：${t.title}` })
  }
  rows.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
  const omitted = Math.max(0, rows.length - MAX_TIMELINE)
  const lines = rows.slice(0, MAX_TIMELINE).map((r) => `[${r.day}] ${r.text}`)
  if (omitted) lines.push(`（时间线仅展示前 ${MAX_TIMELINE} 条，其余 ${omitted} 条略）`)
  return lines
}

/** LLM 缺席时的重要内容降级：近期决策/风险/阻塞事件摘要（≤帽）。 */
function fallbackHighlights(db, pid) {
  return camelizeRows(
    db.prepare(
      "SELECT summary FROM project_events WHERE project_id = ? AND status = 'effective' AND event_type IN ('decision', 'risk', 'blocker') ORDER BY business_time DESC LIMIT ?"
    ).all(pid, MAX_HIGHLIGHTS)
  ).map((r) => r.summary).reverse()
}

/**
 * LLM 分块 map-reduce：消息行按 CHUNK_CHARS 分块（超 MAX_CHUNKS 均匀抽样），每块产要点+金句候选，
 * 再一次定稿合并。单块失败跳过不阻塞；全部失败返回 null（调用方走降级）。
 */
async function summarize(db, llm, projectName, lines) {
  if (!llm || !lines.length) return null
  const chunks = []
  let cur = ''
  for (const line of lines) {
    if (cur && cur.length + line.length + 1 > CHUNK_CHARS) { chunks.push(cur); cur = '' }
    cur += (cur ? '\n' : '') + line
  }
  if (cur) chunks.push(cur)
  let used = chunks
  let sampled = false
  if (chunks.length > MAX_CHUNKS) {
    used = [...new Set(Array.from({ length: MAX_CHUNKS }, (_, i) => chunks[Math.round((i * (chunks.length - 1)) / (MAX_CHUNKS - 1))]))]
    sampled = true
  }
  const notes = []
  const candidates = []
  let okChunks = 0
  for (const chunk of used) {
    try {
      const out = await llm.complete([
        { role: 'system', content: '你在读项目群的聊天记录片段，为项目归档提取素材。只输出 JSON：{"notes":["事实性要点，带时间，≤5条"],"quotes":[{"speaker":"说话人","text":"原话金句——须逐字来自聊天记录，有代表性或体现关键转折，≤5条"}]}。没有就给空数组，禁止编造。' },
        { role: 'user', content: `项目「${projectName}」群聊片段（[MM-DD HH:mm] 说话人: 内容）：\n${chunk}` },
      ], { json: true })
      const parsed = parseJsonLoose(out)
      if (Array.isArray(parsed?.notes)) notes.push(...parsed.notes.filter(Boolean).map(String))
      if (Array.isArray(parsed?.quotes)) candidates.push(...parsed.quotes.filter((q) => q?.text).map((q) => ({ speaker: String(q.speaker || '未识别'), text: String(q.text) })))
      okChunks++
    } catch { /* 单块失败跳过，其余块继续 */ }
  }
  if (!okChunks) return null
  const merged = parseJsonLoose(await llm.complete([
    { role: 'system', content: `你是企业项目大脑，基于各片段提取的素材为项目归档定稿。只输出 JSON：{"highlights":["重要内容（事实性要点，≤${MAX_HIGHLIGHTS}条）"],"quotes":[{"speaker":"说话人","text":"原话金句"}，≤${MAX_QUOTES}条]}。金句保持原话、去重、优先有信息量的；禁止编造素材之外的事实。` },
    { role: 'user', content: `项目「${projectName}」各片段素材：\n${JSON.stringify({ notes, quotes: candidates })}` },
  ], { json: true }))
  const highlights = (Array.isArray(merged?.highlights) ? merged.highlights : notes).filter(Boolean).map(String).slice(0, MAX_HIGHLIGHTS)
  const quotes = (Array.isArray(merged?.quotes) ? merged.quotes : candidates)
    .filter((q) => q?.text).map((q) => ({ speaker: String(q.speaker || '未识别'), text: String(q.text) })).slice(0, MAX_QUOTES)
  return { highlights, quotes, chunkCount: used.length, sampled }
}

/** 群内图片收集：只下载（≤MAX_IMAGES，单张失败跳过不阻塞——权限/坏图不拖垮整体）；上传挂块在写入后统一做。 */
async function collectImageItems(db, cfg, images) {
  const items = []
  for (const m of images.slice(0, MAX_IMAGES)) {
    try {
      const { bytes, contentType } = await downloadChatImage(cfg, m.imageKey)
      const speaker = mapSpeaker(db, 'feishu', m.speakerId)?.name ?? '未识别'
      items.push({ m, bytes, contentType, caption: `${today(m.ts)} ${speaker}` })
    } catch { /* 单张失败跳过不阻塞 */ }
  }
  return items
}

/** 群内附件收集：只下载（<20MB 边界，失败/超限记 skipped）；上传挂块在写入后统一做。 */
async function collectFileItems(db, cfg, files) {
  const items = []
  const skipped = []
  for (const m of files.slice(0, MAX_FILES)) {
    const name = String(m.fileName || m.fileKey)
    try {
      const { bytes, contentType } = await downloadChatFile(cfg, { messageId: m.id, fileKey: m.fileKey }, { maxBytes: MAX_ATTACHMENT_BYTES })
      const speaker = mapSpeaker(db, 'feishu', m.speakerId)?.name ?? '未识别'
      items.push({ m, bytes, contentType, name, caption: `${today(m.ts)} ${speaker} · ${name}` })
    } catch (e) {
      skipped.push({ name, reason: String(e?.message || e).slice(0, 80) })
    }
  }
  const overLimit = files.slice(MAX_FILES)
  for (const m of overLimit) skipped.push({ name: String(m.fileName || m.fileKey), reason: `附件数量超 ${MAX_FILES} 上限未归档` })
  return { items, skipped }
}

/**
 * 素材挂块两段式填充（v0.85.1，官方口径实证）：占位块已随生成区写入文档——
 * image：素材以占位块 id 为 parent 上传（docx_image）→ batch_update replace_image 换入 token；
 * file：占位块创建时飞书自动包 view(33)，先按 view id 拉子块拿真 file 块(23) → 素材挂 file 块上传
 * （docx_file）→ batch_update replace_file。单项失败：尽力清理「图注+占位块」（重列根块按 id 定位、
 * 区间删且从后往前避免索引位移），记 postSkipped 不阻塞其余。
 */
async function fillMediaBlocks(cfg, documentId, created, mediaPlan) {
  let imageDone = 0
  let fileDone = 0
  const postSkipped = []
  const failedPlans = []
  for (const plan of mediaPlan) {
    const item = plan.item
    const name = plan.kind === 'file' ? item.name : `图片 ${today(item.m.ts)}`
    try {
      const holderId = created[plan.blockIdx]?.block_id
      if (!holderId) throw new Error('占位块未返回 block_id')
      if (plan.kind === 'image') {
        const token = await uploadDocImage(cfg, holderId, { fileName: `archive-${item.m.id}.jpg`, bytes: item.bytes, contentType: item.contentType })
        if (!token) throw new Error('素材上传未返回 file_token')
        await batchUpdateDocBlocks(cfg, documentId, [{ block_id: holderId, replace_image: { token } }])
        imageDone++
      } else {
        const kids = await listBlockChildren(cfg, documentId, holderId)
        const fileBlockId = kids.find((b) => b.block_type === 23)?.block_id
        if (!fileBlockId) throw new Error('附件占位块下未找到 file 块')
        const token = await uploadDocFile(cfg, fileBlockId, { fileName: item.name, bytes: item.bytes, contentType: item.contentType })
        if (!token) throw new Error('素材上传未返回 file_token')
        await batchUpdateDocBlocks(cfg, documentId, [{ block_id: fileBlockId, replace_file: { token } }])
        fileDone++
      }
    } catch (e) {
      postSkipped.push({ name, reason: String(e?.message || e).slice(0, 80) })
      failedPlans.push(plan)
    }
  }
  if (failedPlans.length) await cleanupFailedMedia(cfg, documentId, created, failedPlans)
  return { imageDone, fileDone, postSkipped }
}

/** 失败项清理（尽力而为）：重列根块按 block_id 定位，删「图注+占位块」连续区间；多区间从后往前删避免位移。 */
async function cleanupFailedMedia(cfg, documentId, created, plans) {
  try {
    const existing = await listDocRootBlocks(cfg, documentId)
    const idxOf = (id) => (id ? existing.findIndex((b) => b.block_id === id) : -1)
    const ranges = plans
      .map((p) => {
        const ph = idxOf(created[p.blockIdx]?.block_id)
        const cap = p.blockIdx > 0 ? idxOf(created[p.blockIdx - 1]?.block_id) : -1
        return ph < 0 ? null : [cap >= 0 && cap === ph - 1 ? cap : ph, ph + 1] // 图注紧邻占位块才连删
      })
      .filter(Boolean)
      .sort((a, b) => b[0] - a[0])
    for (const [start, end] of ranges) await deleteDocChildren(cfg, documentId, start, end)
  } catch { /* 尽力而为：清理失败不影响台账终态 */ }
}

/** 生成区结构：首标记行 → 关键时间线 → 重要内容 → 群内金句 → 群内图片 → 群内附件 → 尾标记行。
 * 媒体以「图注 text + 空占位块」成对写入；mediaPlan 记录占位块在 blocks 中的下标，写入后两段式填充。 */
function buildArchiveBlocks({ marker, timeline, highlights, quotes, quotesNote, imgItems, imageTotal, fileItems, fileTotal, skippedFiles }) {
  const blocks = [textBlock(marker), heading3('关键时间线')]
  if (timeline.length) timeline.forEach((l) => blocks.push(bullet(l)))
  else blocks.push(textBlock('（事件流暂无记录）'))
  blocks.push(heading3('重要内容'))
  if (highlights.length) highlights.forEach((h) => blocks.push(bullet(h)))
  else blocks.push(textBlock('（无）'))
  blocks.push(heading3('群内金句'))
  if (quotes.length) quotes.forEach((q) => blocks.push(bullet(`「${q.text}」—— ${q.speaker}`)))
  else blocks.push(textBlock(quotesNote))
  const mediaPlan = []
  blocks.push(heading3('群内图片'))
  if (imgItems.length) {
    imgItems.forEach((item) => {
      blocks.push(textBlock(item.caption))
      mediaPlan.push({ kind: 'image', item, blockIdx: blocks.length })
      blocks.push(imagePlaceholder())
    })
  } else blocks.push(textBlock(imageTotal ? '（图片归档失败——检查飞书应用 im:resource 与素材上传权限后重新生成）' : '（群内无图片消息）'))
  blocks.push(heading3('群内附件'))
  if (fileItems.length) {
    fileItems.forEach((item) => {
      blocks.push(textBlock(item.caption))
      mediaPlan.push({ kind: 'file', item, blockIdx: blocks.length })
      blocks.push(filePlaceholder())
    })
  }
  if (skippedFiles.length) blocks.push(textBlock(`（以下附件未归档：${skippedFiles.map((f) => `${f.name}（${f.reason}）`).join('；')}）`))
  if (!fileItems.length && !skippedFiles.length) blocks.push(textBlock(fileTotal ? '（附件归档失败——检查飞书应用 im:resource 与素材上传权限后重新生成）' : '（群内无附件消息）'))
  blocks.push(textBlock(END_MARKER))
  return { blocks, mediaPlan }
}

/** 章节定位：最后一个标题含「项目汇总」的根级标题块；章节末=下一个同级/更高级标题之前。 */
function locateChapter(blocks) {
  const levelOf = (b) => (b.block_type === 3 ? 1 : b.block_type === 4 ? 2 : b.block_type === 5 ? 3 : 0)
  let idx = -1
  for (let i = 0; i < blocks.length; i++) {
    if (levelOf(blocks[i]) > 0 && blockText(blocks[i]).includes(CHAPTER_TITLE)) idx = i
  }
  if (idx < 0) return null
  const level = levelOf(blocks[idx])
  let end = blocks.length
  for (let j = idx + 1; j < blocks.length; j++) {
    const l = levelOf(blocks[j])
    if (l > 0 && l <= level) { end = j; break }
  }
  return { headingIdx: idx, level, end }
}

/**
 * 写入章节：① 上次生成区还在（runs 锚点 firstBlockId，丢失按首标记前缀扫描兜底）→ 删旧区原位写新版；
 * ② 否则定位最后一个「项目汇总」章节末尾插入；③ 无该章节 → 文末新建 heading2 章节再写。
 * 返回按序的全部创建结果（含 block_id；首块即幂等锚点，媒体占位块也在此列——fillMediaBlocks 按下标对应）。
 */
async function writeArchiveSection(db, cfg, pid, documentId, blocks) {
  const existing = await listDocRootBlocks(cfg, documentId)
  const prev = db
    .prepare("SELECT first_block_id FROM wiki_archive_runs WHERE project_id = ? AND status = 'done' AND first_block_id IS NOT NULL ORDER BY id DESC LIMIT 1")
    .get(pid)
  let startIdx = prev?.firstBlockId ? existing.findIndex((b) => b.block_id === prev.firstBlockId) : -1
  if (startIdx < 0) startIdx = existing.findIndex((b) => b.block_type === 2 && blockText(b).startsWith(START_PREFIX))
  if (startIdx >= 0) {
    // 旧生成区：[首标记, 尾标记(含)]；尾标记丢失（上次写一半）时删到文末/下一章节末
    let endIdx = existing.length
    for (let j = startIdx + 1; j < existing.length; j++) {
      if (existing[j].block_type === 2 && blockText(existing[j]).startsWith(END_MARKER)) { endIdx = j + 1; break }
    }
    await deleteDocChildren(cfg, documentId, startIdx, endIdx)
    return insertDocBlocks(cfg, documentId, blocks, startIdx)
  }
  const chapter = locateChapter(existing)
  if (chapter) return insertDocBlocks(cfg, documentId, blocks, chapter.end)
  return insertDocBlocks(cfg, documentId, [heading2(CHAPTER_TITLE), ...blocks])
}
