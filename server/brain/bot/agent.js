// S20 有界 ReAct 循环（K9）：LLM 每轮输出一个 JSON 动作（query / metric / brief / morning / write / reply），
// 工具结果回灌为下一轮输入；≤ maxTurns 轮 LLM、≤ MAX_QUERIES 次查询；写动作即终止（回执/确认卡由编排层发送）。
// 读侧放开（查询无害且有据作答），写侧收敛（write 只有一次，生效路径由 tools 分发器定性）。

import { parseJsonLoose } from '../llm.js'

export const MAX_LLM_TURNS = 6
export const MAX_QUERIES = 8
export const MAX_HISTORY = 12 // S24 web 会话多轮上下文条数（chat.js 取最近 N 条注入）

/**
 * @param {object} args
 * @param {object} args.llm            适配器（complete(messages, {json}) → string）
 * @param {string} args.systemPrompt   系统提示（含身份/上下文/schema/规则）
 * @param {string} args.userText       用户原话
 * @param {Array<{role:string,content:string}>} [args.history] 多轮上下文（S24：插在 system 之后，最近 N 条）
 * @param {(parsed:object) => Promise<string|object>} args.execTool 执行动作；查询类返回反馈文本，write 返回 writeResult 对象
 * @returns {Promise<{kind:'reply'|'write', result?:string, text?:string, writeResult?:object, turns:number, queries:number}>}
 */
export async function runAgentLoop({ llm, systemPrompt, userText, history = [], execTool, maxTurns = MAX_LLM_TURNS }) {
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.slice(-MAX_HISTORY),
    { role: 'user', content: userText },
  ]
  let queries = 0
  for (let turns = 1; turns <= maxTurns; turns++) {
    const out = await llm.complete(messages, { json: true, temperature: 0.2 })
    const parsed = parseJsonLoose(out)
    if (!parsed || !parsed.action) {
      return {
        kind: 'reply', result: 'replied',
        text: '抱歉，这句我没听懂。可以试试：「我的任务」「A 项目现在怎么样」「登记风险：接口联调卡住」，或发 /help 看能力清单。',
        turns, queries,
      }
    }
    if (parsed.action === 'reply' || parsed.action === 'clarify') {
      return {
        kind: 'reply', result: parsed.action === 'clarify' ? 'clarified' : 'replied',
        text: String(parsed.text || '').slice(0, 3000), turns, queries,
      }
    }
    if (parsed.action === 'query' || parsed.action === 'metric' || parsed.action === 'brief' || parsed.action === 'morning') {
      if (queries >= MAX_QUERIES) {
        messages.push({ role: 'assistant', content: out }, { role: 'user', content: `查询次数已达上限（${MAX_QUERIES} 次），请基于已取回的信息直接 reply。` })
        continue
      }
      queries += 1
      const feedback = await execTool(parsed)
      messages.push({ role: 'assistant', content: out }, { role: 'user', content: `工具结果：${feedback}` })
      continue
    }
    if (parsed.action === 'write') {
      const writeResult = await execTool(parsed)
      return { kind: 'write', writeResult, turns, queries }
    }
    messages.push({ role: 'assistant', content: out }, { role: 'user', content: `未知动作 ${parsed.action}，请输出 query / metric / brief / write / reply 之一的 JSON。` })
  }
  return { kind: 'reply', result: 'replied', text: '这句指令需要的查询步骤太多，我中断了。换个更具体的问法试试？', turns: maxTurns, queries }
}
