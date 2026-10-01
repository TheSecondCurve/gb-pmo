// 大脑·任务模板 AI 起草（S17-9，v0.8）：LLM 按模板名+说明产任务清单草稿（v0.6 扁平模型）。
// 信任边界：只产草稿不落库，确认/修改走既有模板保存通道；LLM 未配置给明确指引，不降级瞎生成。

import { getLlm, parseJsonLoose } from './llm.js'

const MAX_TASKS = 15
const MIN_TASKS = 3

/** 清洗单条 LLM 任务标题：去序号/项目符号前缀、限长。 */
function cleanTitle(raw) {
  return String(raw ?? '')
    .trim()
    .replace(/^\d+\s*[.、)．]?\s*/, '')
    .replace(/^[-*•·]\s*/, '')
    .slice(0, 50)
    .trim()
}

export async function draftTemplateTasks(db, { name, description }, { llm: llmOverride } = {}) {
  const llm = getLlm(db, llmOverride)
  if (!llm) {
    throw Object.assign(new Error('LLM 未配置：请先在配置台「外部依赖 → LLM」配置任一类别（DeepSeek / GLM 国内 Coding Plan，可先「测试连接」）后再用 AI 起草'), { statusCode: 503 })
  }
  const out = await llm.complete(
    [
      {
        role: 'system',
        content: `你是企业项目大脑的任务模板起草器。根据模板名称与说明，产出该类项目的任务清单草稿，输出 JSON {"tasks":["任务标题",...]}。
规则：${MIN_TASKS}~${MAX_TASKS} 条；每条一句中文动宾短语（不超过 30 字、句尾不加标点）；覆盖该类项目从启动到结项的关键节点，按执行顺序排列；无阶段分组、无编号编号前缀；与项目无关的话不要说；只输出 JSON。`,
      },
      { role: 'user', content: `模板名称：${name}\n说明：${description?.trim() || '（无，按名称理解项目类型）'}` },
    ],
    { json: true }
  )
  const parsed = parseJsonLoose(out)
  const tasks = [...new Set((Array.isArray(parsed?.tasks) ? parsed.tasks : []).map(cleanTitle).filter(Boolean))]
  if (tasks.length < MIN_TASKS) {
    throw Object.assign(new Error(`LLM 生成的任务清单过少（${tasks.length} 条 < ${MIN_TASKS}），请补充说明后重试`), { statusCode: 502 })
  }
  return { tasks: tasks.slice(0, MAX_TASKS) }
}
