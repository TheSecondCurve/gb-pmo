// S34（v0.35）S3 兼容客户端：AWS Signature Version 4 手写签名（node:crypto，零新依赖），
// 一套协议覆盖阿里云 OSS（S3 兼容 API）/ Cloudflare R2 / AWS S3 / MinIO。
// 签名实现以 AWS 官方文档示例向量为单测锚点（server/test/s34-backup.test.mjs，防实现回归）。
// 只实现备份所需四个操作：HEAD 桶 / PUT / DELETE / ListObjectsV2——不引 SDK，不做分页（单次 max-keys=1000 足够）。
import crypto from 'node:crypto'

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
const TIMEOUT_MS = 120_000

export function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex')
}

/** AWS SigV4 签名（纯函数）。headers 须为小写键名对象（必须含 host 与 x-amz-date），按键名排序参与签名。 */
export function signAwsV4({ method, canonicalUri, query = '', service, region, accessKeyId, secretAccessKey, headers, payloadHash }) {
  const amzDate = headers['x-amz-date']
  const date = amzDate.slice(0, 8)
  const names = Object.keys(headers).sort()
  const signedHeaders = names.join(';')
  const canonicalHeaders = names.map((k) => `${k}:${String(headers[k]).trim()}\n`).join('')
  const canonicalRequest = [method, canonicalUri, query, canonicalHeaders, signedHeaders, payloadHash].join('\n')
  const scope = `${date}/${region}/${service}/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n')
  const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest()
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, date), region), service), 'aws4_request')
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex')
  return `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
}

function bad(msg) {
  return Object.assign(new Error(msg), { statusCode: 400 })
}

/** endpoint 规范化：仅 http(s)、取 origin/host；不合法 400（配置台/测试连接共用）。 */
function parseEndpoint(endpoint) {
  let u
  try {
    u = new URL(String(endpoint))
  } catch {
    throw bad('backup.endpoint 不是合法 URL（须形如 https://oss-cn-hangzhou.aliyuncs.com）')
  }
  if (!/^https?:$/.test(u.protocol)) throw bad('backup.endpoint 仅支持 http(s)')
  if (!u.host) throw bad('backup.endpoint 缺少主机名')
  return u
}

/** region 推断：显式优先；R2=auto；OSS（oss-xxx.aliyuncs.com）=地域前缀；其余（MinIO/自建/AWS）默认 us-east-1。 */
export function resolveRegion(cfg, host) {
  if (cfg.region) return cfg.region
  if (/\.r2\.cloudflarestorage\.com$/.test(host)) return 'auto'
  if (/^oss-[a-z0-9-]+\.aliyuncs\.com$/.test(host)) return host.split('.')[0]
  return 'us-east-1'
}

/** S3 对象键编码：按 '/' 分段、段内仅保留 A-Za-z0-9-_.~，其余 percent-encode（S3 规范不做二次编码）。 */
function encodeKey(key) {
  return String(key).split('/').map((seg) => encodeURIComponent(seg)).join('/')
}

/** query 参数按名排序、值全编码（'/' 亦编码）拼 canonical query string。 */
function canonicalQuery(params) {
  return Object.entries(params)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&')
}

function decodeXmlEntities(s) {
  return s.replace(/&(amp|lt|gt|quot|apos);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e]))
}

/**
 * 构造 S3 客户端。cfg 即 settings.backup（endpoint/region/bucket/accessKeyId/secretAccessKey/pathStyle）。
 * fetchImpl 可注入（测试假实现，不发真实网络）；now 可注入（签名时间确定性）。
 * 返回 { region, host, headBucket, put, del, list }，每个操作回 { ok, status, error, keys? }——
 * 网络异常折叠为 ok:false + error（不 throw）；error 已含上游 Code/Message（HEAD 无体则仅 HTTP 状态）。
 */
export function s3Client(cfg, { fetchImpl = globalThis.fetch.bind(globalThis), now = () => new Date() } = {}) {
  const u = parseEndpoint(cfg.endpoint)
  const region = resolveRegion(cfg, u.host)
  const host = cfg.pathStyle ? u.host : `${cfg.bucket}.${u.host}`
  // 请求源（=真实 URL 前缀）：virtual-hosted 桶在子域名；path-style 桶在路径首段
  const origin = cfg.pathStyle ? u.origin : `${u.protocol}//${host}`
  const pathPrefix = cfg.pathStyle ? `/${encodeKey(cfg.bucket)}` : ''

  const requestPath = (key) => (key ? `${pathPrefix}/${encodeKey(key)}` : pathPrefix || '/')

  async function doReq({ method, key = '', query = '', body, contentType }) {
    const canonicalUri = requestPath(key)
    const hash = body ? sha256Hex(body) : EMPTY_SHA256
    const amzDate = now().toISOString().replace(/[:-]|\.\d{3}/g, '') // 20261008T033000Z
    const headers = { host, 'x-amz-content-sha256': hash, 'x-amz-date': amzDate }
    const authorization = signAwsV4({
      method, canonicalUri, query, service: 's3', region,
      accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, headers, payloadHash: hash,
    })
    const url = query ? `${origin}${canonicalUri}?${query}` : `${origin}${canonicalUri}`
    let res
    try {
      res = await fetchImpl(url, {
        method,
        headers: {
          authorization,
          'x-amz-content-sha256': hash,
          'x-amz-date': amzDate,
          ...(contentType ? { 'content-type': contentType } : {}),
        },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (e) {
      return { ok: false, status: 0, error: `网络不通或 endpoint 错误（${e.message}）` }
    }
    if (res.ok) return { ok: true, status: res.status, res }
    let error = `HTTP ${res.status}`
    try {
      const text = await res.text()
      const code = text.match(/<Code>([\s\S]*?)<\/Code>/)?.[1]
      const message = text.match(/<Message>([\s\S]*?)<\/Message>/)?.[1]
      if (code || message) error = `${code || ''} ${decodeXmlEntities(message || '')}`.trim()
    } catch {
      /* HEAD 无响应体，保留 HTTP 状态 */
    }
    return { ok: false, status: res.status, error }
  }

  return {
    region,
    host,
    headBucket: () => doReq({ method: 'HEAD' }),
    put: (key, body) => doReq({ method: 'PUT', key, body, contentType: 'application/gzip' }),
    del: (key) => doReq({ method: 'DELETE', key }),
    async list(prefix) {
      const out = await doReq({ method: 'GET', query: canonicalQuery({ 'list-type': 2, 'max-keys': 1000, prefix }) })
      if (!out.ok) return out
      const text = await out.res.text()
      const keys = [...text.matchAll(/<Key>([\s\S]*?)<\/Key>/g)].map((m) => decodeXmlEntities(m[1]))
      return { ok: true, status: out.status, keys }
    },
  }
}
