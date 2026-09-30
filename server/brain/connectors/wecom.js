// 企微连接器（K6）：会话存档 = 付费开通 + 官方 C SDK（Linux）拉取 + RSA 解密（PRD 附录 A.2）。
// 本模块实现配置/游标/编排骨架；真实拉取经 sdkUrl 代理（部署侧跑官方 SDK 的轻量 HTTP sidecar）。

export async function fetchMessages(cfg, channel, cursor) {
  const missing = ['corpId', 'secret', 'privateKey', 'sdkUrl'].filter((k) => !cfg[k])
  if (missing.length || !cfg.sdkUrl) {
    throw Object.assign(
      new Error(
        `企微会话存档未就绪（缺 ${missing.join('/') || 'sdkUrl'}）：需在企业微信管理后台开通会话内容存档并部署官方 C SDK 代理，步骤见 PRD 附录 A.2；未开通期间企微渠道自动降级为成员 Agent 口述更新`
      ),
      { statusCode: 503 }
    )
  }
  const res = await fetch(String(cfg.sdkUrl).replace(/\/+$/, '') + '/pull', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ seq: Number(cursor || 0), limit: 200, chatId: channel.groupKey }),
  })
  if (!res.ok) throw Object.assign(new Error(`企微 SDK 代理 HTTP ${res.status}`), { statusCode: 502 })
  const data = await res.json()
  return {
    messages: (data.messages || []).map((m) => ({ id: m.id, speakerId: m.speakerId, text: m.text, ts: m.ts })),
    nextCursor: String(data.nextCursor ?? cursor ?? 0),
  }
}

export async function testConnection(cfg) {
  if (!cfg.corpId || !cfg.secret || !cfg.privateKey) {
    return { ok: false, reason: '未配置 corpId/secret/privateKey（需管理后台开通会话存档并上传 RSA 公钥，见 PRD 附录 A.2）' }
  }
  if (!cfg.sdkUrl) {
    return { ok: false, reason: '官方 C SDK 代理未部署（im.wecom.sdkUrl 未配置；SDK 仅 Linux 原生，建议容器化 sidecar）' }
  }
  try {
    const res = await fetch(String(cfg.sdkUrl).replace(/\/+$/, '') + '/health')
    return res.ok ? { ok: true } : { ok: false, reason: `SDK 代理健康检查 HTTP ${res.status}` }
  } catch (e) {
    return { ok: false, reason: `SDK 代理不可达: ${e.message}` }
  }
}
