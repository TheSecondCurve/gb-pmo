import { loginCookie, authed } from './helpers.mjs'

// S20 机器人测试共享工具（s20-bot-*.test.mjs 子域文件共用）：
// fake LLM 注入脚本化 JSON 动作，send 注入记录器；不走真实飞书与真实 LLM（K7：真库 + inject）。
// 每个测试文件各自 setupApp 独立临时库，make* 工厂按文件各建一份计数器。

export const BOT_SECRET = 's20-test-bot-hmac-secret-32-bytes!'

/** 脚本化 fake LLM：依次弹出动作 JSON，并记录收到的 messages（断言 system prompt）。 */
export function scriptedLlm(...actions) {
  const calls = []
  return {
    calls,
    llm: {
      name: 'fake',
      complete: async (messages) => {
        calls.push(messages)
        return String(actions.shift() ?? '{"action":"reply","text":"（脚本耗尽）"}')
      },
    },
  }
}

/** 出站消息记录器工厂：每文件一份自增 messageId（bot_reply 行以 message_id 落库，INSERT OR IGNORE 防撞）。 */
export function makeRecorder() {
  let replySeq = 0
  return () => {
    const sent = []
    return { sent, send: async (m) => { sent.push(m); return { messageId: `bot_${++replySeq}` } } }
  }
}

/** 飞书入站事件构造器：每文件一份 message_id 自增。 */
export function makeMsgFactory(prefix = 'om_s20') {
  let seq = 0
  const nextMsgId = () => `${prefix}_${++seq}`
  const p2p = (openId, text) => ({ messageId: nextMsgId(), chatId: 'oc_p2p', chatType: 'p2p', senderOpenId: openId, text, ts: Date.now() })
  const group = (openId, chatId, text, extra = {}) => ({ messageId: nextMsgId(), chatId, chatType: 'group', senderOpenId: openId, text, ts: Date.now(), ...extra })
  return { nextMsgId, p2p, group }
}

export async function mkProject(ctx, name, leadId) {
  const cookie = await loginCookie(ctx.app, 'admin', 'admin-pass-123')
  const res = await authed(ctx.app, cookie, 'POST', '/api/v1/projects', {
    name, templateCode: 'lianmai_365', leadMemberId: leadId, planEndDate: '2026-12-31',
  })
  return res.body
}

export const botRow = (ctx, messageId) => ctx.db.prepare('SELECT * FROM bot_commands WHERE message_id = ?').get(messageId)
