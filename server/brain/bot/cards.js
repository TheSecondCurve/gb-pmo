// S45（v0.50，K28）飞书消息卡片模板：晨报 / 任务盘点的确定性渲染（纯函数，不感知 HTTP 与 LLM）。
// 结构选型：标题栏 + 分项目 section；单项目域（专题群=群聊主场景）任务清单用 column_set
// 多列布局（≤TABLE_MAX_ROWS 行成表，超出退化文本行）；多项目域一律分节 lark_md 文本行
// （卡片元素预算护栏）。卡片 2.0 原生 table 组件留待线上实测后另行启用（本期 column_set 保底）。

import { INV_MAX_PER_PROJECT } from '../../engine/tasks.js'

/** 成表行数上限：超出则该段落退化为文本行（元素预算与移动端可读性护栏）。 */
export const TABLE_MAX_ROWS = 8

const md = (content) => ({ tag: 'div', text: { tag: 'lark_md', content } })

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
