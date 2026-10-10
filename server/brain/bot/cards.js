// S45（v0.50，K28）飞书消息卡片模板：晨报 / 任务盘点的确定性渲染（纯函数，不感知 HTTP 与 LLM）。
// 结构选型：标题栏 + 分项目 section；单项目域（专题群=群聊主场景）任务清单用 column_set
// 多列布局（≤TABLE_MAX_ROWS 行成表，超出退化文本行）；多项目域一律分节 lark_md 文本行
// （卡片元素预算护栏）。卡片 2.0 原生 table 组件留待线上实测后另行启用（本期 column_set 保底）。
// S55（v0.60，K38）：建议确认卡（buildSuggestionCard）——抽取面待确认建议的 IM 点按闭环。
// v0.63（K41）：预警/纯提醒卡（buildOverdueAlertCard/buildLoadAlertCard/buildSilentAlertCard/buildReminderCard）——
// 预警巡检与纯提醒推送的卡片形态，投递层降级链（卡片失败→post/text 补发）在 push.js。

import crypto from 'node:crypto'
import { INV_MAX_PER_PROJECT } from '../../engine/tasks.js'
import { MAX_TASK_NOTE } from '../../engine/projectTypes.js'

/** 卡片按钮签名（与 command.js 的 hmac 同构——命令面确认卡与本面建议卡共用一套签名语义）。 */
function hmac(secret, canonical) {
  return crypto.createHmac('sha256', secret).update(canonical).digest('hex').slice(0, 16)
}

/**
 * S55 建议确认卡：待确认建议推送的交互形态——「确认生效/驳回」按钮 value 携带
 * {a:confirm|reject, e:事件id, s:HMAC}，由 handleCardAction 的 confirm/reject 分支承接（v0.46 兼容分支）。
 */
export function buildSuggestionCard({ id, summary, projectName, typeLabel }, secret) {
  const value = (a) => ({ a, e: String(id), s: hmac(secret, `${a}:${id}`) })
  return {
    config: { wide_screen: true },
    header: { template: 'blue', title: { tag: 'plain_text', content: `待确认建议 #${id}${typeLabel ? `（${typeLabel}）` : ''}` } },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: `**${summary}**${projectName ? `\n项目：${projectName}` : ''}\n确认后生效，驳回则忽略（事件流保留痕迹）。` } },
      {
        tag: 'action',
        actions: [
          { tag: 'button', text: { tag: 'plain_text', content: '确认生效' }, type: 'primary', value: value('confirm') },
          { tag: 'button', text: { tag: 'plain_text', content: '驳回' }, type: 'danger', value: value('reject') },
        ],
      },
    ],
  }
}

/** 成表行数上限：超出则该段落退化为文本行（元素预算与移动端可读性护栏）。 */
export const TABLE_MAX_ROWS = 8

const md = (content) => ({ tag: 'div', text: { tag: 'lark_md', content } })

/** S58 备注展示截断：入库已 ≤MAX_TASK_NOTE（引擎单一真相源），此处护栏历史/手工数据撑爆卡片。 */
export function noteText(note) {
  const text = String(note ?? '').trim()
  return text.length > MAX_TASK_NOTE ? `${text.slice(0, MAX_TASK_NOTE)}…` : text
}

/** 多列布局表：header 行加粗 + 数据行；weights 为各列权重。 */
function table(headers, rows, weights) {
  const mkRow = (cells, bold) => ({
    tag: 'column_set', flex_mode: 'none', background_style: 'default',
    columns: cells.map((c, i) => ({
      tag: 'column', width: 'weighted', weight: weights[i] ?? 1, vertical_align: 'top',
      elements: [{ tag: 'div', text: { tag: 'lark_md', content: bold ? `**${c}**` : c } }],
    })),
  })
  return [mkRow(headers, true), ...rows.map((r) => mkRow(r, false))]
}

const card = (template, title, elements) => ({
  config: { wide_screen: true },
  header: { template, title: { tag: 'plain_text', content: title } },
  elements,
})

/**
 * S60（v0.65，K44）群进展播报卡：绿色 header 🎉 + 本轮沉淀的进展列表。
 * items: [{summary}]——record 型 progress 事件摘要；>TABLE_MAX_ROWS 条截断并标注。
 */
export function buildProgressDigestCard({ projectName, items }) {
  const shown = items.slice(0, TABLE_MAX_ROWS)
  const lines = shown.map((it, i) => `${i + 1}. ${it.summary}`)
  if (items.length > TABLE_MAX_ROWS) lines.push(`… 等 ${items.length} 条`)
  return card('green', `🎉 ${projectName} 有新进展`, [
    md(`本轮抽取沉淀 **${items.length}** 条进展：\n${lines.join('\n')}`),
  ])
}

/** S60 播报文本兜底（卡片降级 / web 通知收件箱共用 body）。 */
export function progressDigestBody({ items }) {
  const shown = items.slice(0, TABLE_MAX_ROWS)
  const lines = shown.map((it, i) => `${i + 1}. ${it.summary}`)
  if (items.length > TABLE_MAX_ROWS) lines.push(`… 等 ${items.length} 条`)
  return `本轮抽取沉淀 ${items.length} 条进展：\n${lines.join('\n')}`
}

/**
 * 晨报卡片。输入 = engine morningReport 返回体（projects 为块结构）。
 * 单项目域：今日到期/逾期清单成表（2/3 列）；多项目域：每项目一组 lark_md 文本行 + hr 分隔。
 */
export function buildMorningCard(report) {
  const single = report.projects.length === 1
  const elements = []
  report.projects.forEach((b, idx) => {
    if (idx > 0) elements.push({ tag: 'hr' })
    const head = `**【${b.name}】**${b.statusLabel}${b.remainingDays != null ? ` · 交付剩 ${b.remainingDays} 天` : ''}`
    elements.push(md(`${head}\n进行中 ${b.doingCount} 项，未完共 ${b.openCount} 项`))
    if (b.dueToday.length) {
      elements.push(md(`**📅 今日到期 ${b.dueToday.length}**`))
      if (single && b.dueToday.length <= TABLE_MAX_ROWS) {
        elements.push(...table(['任务', '责任人'], b.dueToday.map((t) => [t.title, t.responsible || '未指派']), [4, 2]))
      } else {
        elements.push(md(b.dueToday.map((t) => `· ${t.title}（${t.responsible || '未指派'}）`).join('\n')))
      }
    }
    if (b.overdueTotal) {
      elements.push(md(`**🔴 逾期 ${b.overdueTotal}**`))
      if (single && b.overdueTasks.length <= TABLE_MAX_ROWS) {
        elements.push(...table(['任务', '超期', '责任人'], b.overdueTasks.map((t) => [t.title, `${t.daysOverdue} 天`, t.responsible || '未指派']), [4, 1, 2]))
      } else {
        const more = b.overdueTotal > b.overdueTasks.length ? `\n（等 ${b.overdueTotal} 项）` : ''
        elements.push(md(b.overdueTasks.map((t) => `· ${t.title}（${t.responsible || '未指派'}，超 ${t.daysOverdue} 天）`).join('\n') + more))
      }
    }
    elements.push(md(b.events.length
      ? `**昨日以来**\n${b.events.map((e) => `· ${e.speaker}：${e.summary}（${e.typeLabel}）`).join('\n')}`
      : '昨日以来无动态'))
  })
  if (!report.projects.length) elements.push(md('当前没有在跑项目。'))
  if (report.more > 0) elements.push(md(`（及其余 ${report.more} 个在跑项目）`))
  return card('blue', `📈 项目大脑晨报 ${report.asOf}（星期${report.weekday}）`, elements)
}

const SECTION_LABEL = { unassigned: '⚠ 未分配责任人', owned: '已分配' }

const invLine = (t) => `· #${t.id} ${t.title}（${t.statusLabel}${t.planEndDate ? `，截止 ${t.planEndDate}` : ''}${t.responsibleName ? `，${t.responsibleName}` : ''}）`

/**
 * 任务盘点卡片。输入 = engine tasksInventory 返回体（含 groups；scope='project' 单项目 / 'all' 多项目）。
 * 单项目域：分段（未分配/已分配）≤TABLE_MAX_ROWS 行成表（任务/状态·截止/责任人 3 列），超出退化文本行；
 * 多项目域：每项目一节文本行，全有主项目标「均已分配」。汇总行复用 text 首行（口径唯一）。
 */
export function buildTasksInventoryCard(inv) {
  const single = inv.scope === 'project'
  const elements = [md(`**${String(inv.text).split('\n')[0]}**`)]
  for (const g of inv.groups || []) {
    const hasTasks = (g.sections || []).some((s) => s.tasks.length)
    if (!single) elements.push(md(`**【${g.name}】**${hasTasks ? '' : '均已分配'}`))
    for (const sec of g.sections || []) {
      if (!sec.tasks.length) continue
      const labelText = SECTION_LABEL[sec.key]
      if (labelText) elements.push(md(`**${labelText}（${sec.tasks.length}）**`))
      if (single && sec.tasks.length <= TABLE_MAX_ROWS) {
        elements.push(...table(
          ['任务', '状态 · 截止', '责任人'],
          sec.tasks.map((t) => [`#${t.id} ${t.title}`, `${t.statusLabel}${t.planEndDate ? ` · ${t.planEndDate}` : ''}`, t.responsibleName || '未指派']),
          [4, 2, 2],
        ))
      } else {
        const lines = sec.tasks.slice(0, INV_MAX_PER_PROJECT).map(invLine)
        if (sec.tasks.length > INV_MAX_PER_PROJECT) lines.push(`（其余 ${sec.tasks.length - INV_MAX_PER_PROJECT} 条略）`)
        elements.push(md(lines.join('\n')))
      }
    }
  }
  const title = single ? `任务盘点 · ${inv.projectName}` : '未分配任务盘点'
  return card('wathet', title, elements)
}

// —— v0.63（K41）：预警与纯提醒卡片 ——

/**
 * S7-1 逾期任务预警卡：红色 header + column_set 表格（任务/项目/截止/超期）；
 * ≤TABLE_MAX_ROWS 行成表、超出退化文本行（S45 元素预算护栏）；
 * S23 参考资料以 lark_md 链接行留在表下。tasks: [{id,title,projectName,planEndDate,daysOverdue,refs?}]。
 */
export function buildOverdueAlertCard({ memberName, tasks }) {
  const elements = [md(`你有 **${tasks.length}** 项逾期未完任务：`)]
  if (tasks.length <= TABLE_MAX_ROWS) {
    elements.push(...table(
      ['任务', '项目', '截止', '超期'],
      tasks.map((t) => [t.title, t.projectName, t.planEndDate, `超 ${t.daysOverdue} 天`]),
      [4, 3, 2, 2],
    ))
  } else {
    elements.push(md(tasks.map((t) => `· ${t.title}（${t.projectName}，截止 ${t.planEndDate}，超 ${t.daysOverdue} 天）`).join('\n')))
  }
  const refLines = tasks
    .filter((t) => t.refs?.length)
    .map((t) => `· ${t.title}：${t.refs.map((r) => `[${r.title}](${r.url})`).join('、')}`)
  if (refLines.length) elements.push(md(`**参考**\n${refLines.join('\n')}`))
  // S58：任务备注「怎么干」与参考同管道渲染（表格外文本行，不挤占 column_set 列宽）
  const noteLines = tasks.filter((t) => t.note).map((t) => `· ${t.title}：${noteText(t.note)}`)
  if (noteLines.length) elements.push(md(`**备注**\n${noteLines.join('\n')}`))
  return card('red', `逾期任务预警：${memberName}（${tasks.length} 项）`, elements)
}

/** S7-2 负载预警卡：橙色 header + 事实一段。 */
export function buildLoadAlertCard({ member, parallelProjects, maxParallelProjects, openTasks }) {
  return card('orange', `负载预警：${member}`, [
    md(`**${member}** 并行参与 **${parallelProjects}** 个进行中项目（上限 ${maxParallelProjects}），未完任务 **${openTasks}** 项。`),
  ])
}

/** S48-4 沉默项目预警卡：橙色 header + 项目名与沉默天数。 */
export function buildSilentAlertCard({ projectName, days }) {
  return card('orange', `沉默项目预警：${projectName}`, [
    md(`项目「**${projectName}**」已连续 **${days}** 天无已生效事件且无任务变动。\n请关注：是真停滞还是讨论没进群？`),
  ])
}

/** S57 纯提醒卡：wathet header ⏰ + 项目/提醒日/责任人/备注（S58）；一次性送达语义写在卡片里。 */
export function buildReminderCard({ title, projectName, planEndDate, responsibleName, note }) {
  return card('wathet', `⏰ 提醒：${title}`, [
    md(`项目：**${projectName}**\n提醒日：${planEndDate}${responsibleName ? `\n责任人：**${responsibleName}**` : ''}${note ? `\n备注：${noteText(note)}` : ''}\n一次性送达，任务已自动标记完成（不追踪状态）。`),
  ])
}
