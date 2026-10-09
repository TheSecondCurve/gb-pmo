// 通用群分拣（D5 / S3-2）：LLM 结合在跑项目上下文给出候选项目与置信度；
// 低于阈值进未分拣池。LLM 未配置时用确定性降级（项目名/客户名关键词匹配，置信度 0.5）。

import { parseJsonLoose } from './llm.js'

export async function routeMessage(db, msg, { llm } = {}) {
  const projects = db
    .prepare(
      `SELECT p.id, p.name, p.client_name FROM projects p WHERE p.status = 'active'`
    )
    .all()
  if (!projects.length) return { projectId: null, confidence: 0 }

  if (!llm) {
    for (const p of projects) {
      const keys = [p.name, p.client_name].filter(Boolean)
      if (keys.some((k) => k.length >= 2 && msg.text.includes(k))) {
        return { projectId: p.id, confidence: 0.5 }
      }
    }
    return { projectId: null, confidence: 0 }
  }

  const list = projects.map((p) => `#${p.id} ${p.name}${p.client_name ? `（客户:${p.client_name}）` : ''}`).join('\n')
  const out = await llm.complete(
    [
      {
        role: 'system',
        content:
          '你是企业项目大脑的消息分拣器。判断下面这条群消息属于哪个在跑项目，输出 JSON：{"projectId": <id 或 null>, "confidence": <0~1>}。只输出 JSON。',
      },
      { role: 'user', content: `在跑项目清单：\n${list}\n\n消息（${msg.speakerLabel || '未知'}）：${msg.text}` },
    ],
    { json: true }
  )
  const parsed = parseJsonLoose(out)
  if (!parsed || typeof parsed.projectId !== 'number' && parsed.projectId !== null) {
    return { projectId: null, confidence: 0 }
  }
  const valid = projects.some((p) => p.id === parsed.projectId) ? parsed.projectId : null
  return { projectId: valid, confidence: Math.min(1, Math.max(0, Number(parsed.confidence) || 0)) }
}
