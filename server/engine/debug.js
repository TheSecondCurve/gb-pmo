// S26（v0.19）管理员诊断台：容器内排障命令执行。只服务运维排障，不属于任何业务流。
// 安全边界（PRD §7.9）：仅管理员（routes 层判）+ debug.shellEnabled 默认关 + /bin/sh（slim 镜像无 bash）+ 全量审计。
import { exec } from 'node:child_process'
import { getSetting } from './settings.js'
import { audit } from './auth.js'

/**
 * 执行一条诊断命令。返回 { stdout, stderr, code, timedOut, truncated, durationMs }。
 * 拒绝（开关关/参数缺）也留审计（审计在 throw 前落）。
 */
export async function runShell(db, command, memberId) {
  const cfg = getSetting(db, 'debug')
  if (!cfg.shellEnabled) {
    audit(db, { memberId, action: 'debug.shell', objectType: 'debug', detail: { command: String(command ?? ''), rejected: 'shellEnabled 关闭' } })
    throw Object.assign(new Error('诊断 shell 未开启：请在配置台「运维诊断」打开 shellEnabled 开关（用完建议关闭，S26）'), { statusCode: 400 })
  }
  if (typeof command !== 'string' || !command.trim()) {
    throw Object.assign(new Error('command 必填'), { statusCode: 400 })
  }
  const started = Date.now()
  const out = await new Promise((resolve) => {
    exec(command, { shell: '/bin/sh', timeout: cfg.timeoutMs, maxBuffer: cfg.maxOutputBytes, encoding: 'buffer' }, (err, stdout, stderr) => {
      resolve({ err, stdout, stderr })
    })
  })
  const durationMs = Date.now() - started
  // timeout 杀进程（killed）与 maxBuffer 超限（killed + message 含 maxBuffer）区分：前者才是 timedOut
  const maxBufferHit = /maxBuffer/i.test(out.err?.message || '')
  const timedOut = Boolean(out.err?.killed) && !maxBufferHit
  const code = typeof out.err?.code === 'number' ? out.err.code : out.err ? -1 : 0
  const stdout = clip(out.stdout, cfg.maxOutputBytes)
  const stderr = clip(out.stderr, cfg.maxOutputBytes)
  const truncated = stdout.truncated || stderr.truncated || maxBufferHit
  audit(db, { memberId, action: 'debug.shell', objectType: 'debug', detail: { command, code, timedOut, truncated, durationMs } })
  return { stdout: stdout.text, stderr: stderr.text, code, timedOut, truncated, durationMs }
}

function clip(buf, cap) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || '')
  return { text: b.subarray(0, cap).toString('utf8'), truncated: b.length > cap }
}
