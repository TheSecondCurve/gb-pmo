// S45（v0.50，K28）文本→post 富文本转换器：确定性手写解析，零依赖。
// 判定规则：文本含换行 / `**` 粗体标记 / URL 即走 post；单行纯文本返回 null（调用方维持 text）。
// 仅这三类结构——LLM 答复与引擎文本的既有书写习惯（段落、加粗、链接），不引入完整 markdown。

const TOKEN_RE = /(\*\*[^*\n]+\*\*|https?:\/\/[^\s，。；：）\]】"'<>、]+)/g

/** 一行 → post 行内 runs：粗体段 style:['bold']，URL → a 标签，其余原样 text。 */
function runsFor(line) {
  const runs = []
  let last = 0
  for (const m of line.matchAll(TOKEN_RE)) {
    if (m.index > last) runs.push({ tag: 'text', text: line.slice(last, m.index) })
    const tok = m[0]
    if (tok.startsWith('**')) runs.push({ tag: 'text', text: tok.slice(2, -2), style: ['bold'] })
    else runs.push({ tag: 'a', text: tok, href: tok })
    last = m.index + tok.length
  }
  if (last < line.length) runs.push({ tag: 'text', text: line.slice(last) })
  return runs
}

/**
 * 文本 → 飞书 post content（{ zh_cn: { content: [[run]…] } }）。
 * 空行=空段落；未闭合的 `**` 不成 token、原样保留（不吞字符）。
 * 不需要富格式的文本（单行且无标记无链接）返回 null。
 */
export function richPost(text) {
  const t = String(text || '')
  if (!t) return null
  if (!/[\n*]|https?:\/\//.test(t)) return null
  return {
    zh_cn: {
      title: '',
      content: t.split('\n').map((line) => (line ? runsFor(line) : [])),
    },
  }
}
