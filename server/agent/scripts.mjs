// Agent 接入栈脚本渲染（agent-integration.md 形态 B）：skill 与脚本零密钥，凭证只在客户本机。
// Host 头白名单校验：非法值回退 127.0.0.1，防 shell 注入。

export function safeBaseUrl(hostHeader, configuredBaseUrl) {
  const configured = configuredBaseUrl || 'http://127.0.0.1:8086'
  if (!hostHeader) return configured
  if (!/^[a-zA-Z0-9._-]+(:\d+)?$/.test(hostHeader)) return 'http://127.0.0.1:8086'
  try {
    const u = new URL(configured)
    const host = hostHeader.split(':')[0]
    const allow = new Set([u.hostname, '127.0.0.1', 'localhost', '::1'])
    if (!allow.has(host)) return 'http://127.0.0.1:8086'
    return `http://${hostHeader}`
  } catch {
    return 'http://127.0.0.1:8086'
  }
}

export function renderLoginSh(baseUrl, version) {
  return `#!/usr/bin/env bash
# gb-pmo Agent 授权脚本 v${version}
# 密码只走终端 /dev/tty（静默回显），绝不经过 Agent 对话。
set -e
BASE_URL="\${GB_PMO_BASE_URL:-${baseUrl}}"
CRED_DIR="\${HOME}/.gb-pmo"
CRED_FILE="$CRED_DIR/credentials.json"
if [ "\${X_SKIP_LOGIN:-0}" = "1" ] && [ -f "$CRED_FILE" ]; then
  echo "已存在凭证，跳过授权（X_FORCE_LOGIN=1 可强制重签）"
  exit 0
fi
if [ "\${X_FORCE_LOGIN:-0}" = "1" ]; then rm -f "$CRED_FILE"; fi
if [ -f "$CRED_FILE" ]; then echo "已存在凭证（$(stat -f %Sp "$CRED_FILE" 2>/dev/null || stat -c %a "$CRED_FILE")），跳过授权；重签请 X_FORCE_LOGIN=1"; exit 0; fi
printf "gb-pmo 用户名: "
read -r USERNAME < /dev/tty || true
# 密码静默读取（v0.34.1）：stty -echo + read——回车即返回；不可用 head -c N（读满 N 字节或 EOF 才返回，
# 交互 tty 上永远等不齐 → 输完密码卡死）。curl|sh 管道下 shebang 无效、dash 无 read -s，故走 POSIX stty。
printf "gb-pmo 密码: "
stty -echo < /dev/tty
PASSWORD=''
read -r PASSWORD < /dev/tty || true
stty echo < /dev/tty
echo
RESP=$(curl -fsS --noproxy '127.0.0.1,localhost' -X POST "$BASE_URL/api/v1/auth/agent-login" \\
  -H 'Content-Type: application/json' \\
  -d "{\\"username\\":\\"$USERNAME\\",\\"password\\":\\"$PASSWORD\\"}") || { echo "授权失败：检查用户名/密码与服务地址"; exit 1; }
TOKEN=$(printf '%s' "$RESP" | sed -n 's/.*"token":"\\([^"]*\\)".*/\\1/p')
SCOPE=$(printf '%s' "$RESP" | sed -n 's/.*"scope":"\\([^"]*\\)".*/\\1/p')
EXPIRES=$(printf '%s' "$RESP" | sed -n 's/.*"expiresAt":\\([0-9]*\\).*/\\1/p')
[ -n "$TOKEN" ] || { echo "解析令牌失败"; exit 1; }
mkdir -p "$CRED_DIR" && chmod 700 "$CRED_DIR"
TMP="$CRED_FILE.tmp"
printf '{\\"baseUrl\\":\\"%s\\",\\"token\\":\\"%s\\",\\"scope\\":\\"%s\\",\\"expiresAt\\":%s}\\n' "$BASE_URL" "$TOKEN" "$SCOPE" "$EXPIRES" > "$TMP"
mv "$TMP" "$CRED_FILE"
chmod 600 "$CRED_FILE"
echo "授权成功，凭证写入 $CRED_FILE（scope=$SCOPE，90 天有效）"
`
}

export function renderLoginPs1(baseUrl, version) {
  // PowerShell 安装器必须纯 ASCII（BOM 会让 irm|iex 把首行当命令名）
  const b = baseUrl.replace(/'/g, "''")
  return `# gb-pmo Agent auth script v${version}
$ErrorActionPreference = 'Stop'
$BaseUrl = if ($env:GB_PMO_BASE_URL) { $env:GB_PMO_BASE_URL } else { '${b}' }
$CredDir = Join-Path $env:USERPROFILE '.gb-pmo'
$CredFile = Join-Path $CredDir 'credentials.json'
if ((Test-Path $CredFile) -and ($env:X_SKIP_LOGIN -eq '1')) { Write-Output 'credentials exist, skip'; exit 0 }
$Username = Read-Host 'gb-pmo username'
$Secure = Read-Host 'gb-pmo password' -AsSecureString
$Bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
$Password = [Runtime.InteropServices.Marshal]::PtrToStringAuto($Bstr)
$body = @{ username = $Username; password = $Password } | ConvertTo-Json
$resp = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/v1/auth/agent-login" -ContentType 'application/json' -Body $body
New-Item -ItemType Directory -Force -Path $CredDir | Out-Null
@{ baseUrl = $BaseUrl; token = $resp.token; scope = $resp.scope; expiresAt = $resp.expiresAt } | ConvertTo-Json | Set-Content -Path $CredFile
Write-Output "auth ok, credentials at $CredFile"
`
}

export function renderInstallSh(baseUrl, version) {
  return `#!/usr/bin/env bash
# gb-pmo Agent skill 安装器 v${version} —— 更新 = 重跑同一条命令（服务器单方面决定最新态）
set -e
BASE_URL="\${GB_PMO_BASE_URL:-${baseUrl}}"
SKILL_DIR_NAME="gb-pmo"
fetch() { curl -fsS --noproxy '127.0.0.1,localhost' "$1"; }
TARGETS=()
[ -d ".agents/skills" ] && TARGETS+=(".agents/skills/$SKILL_DIR_NAME")
TARGETS+=("$HOME/.agents/skills/$SKILL_DIR_NAME")
[ -d "$HOME/.codex/skills" ] && TARGETS+=("$HOME/.codex/skills/$SKILL_DIR_NAME")
[ -d "$HOME/.claude/skills" ] && TARGETS+=("$HOME/.claude/skills/$SKILL_DIR_NAME")
for T in "\${TARGETS[@]}"; do
  mkdir -p "$T"
  fetch "$BASE_URL/agent/skill/$SKILL_DIR_NAME/SKILL.md" > "$T/SKILL.md"
  fetch "$BASE_URL/agent/skill/$SKILL_DIR_NAME/client.sh" > "$T/client.sh"
  chmod +x "$T/client.sh"
  echo "installed -> $T"
done
echo "skill v${version} 安装完成。首次使用先运行授权：curl -fsSL $BASE_URL/agent/login.sh | sh"
`
}

export function renderClientSh(version) {
  return `#!/usr/bin/env bash
# gb-pmo Agent 客户端 v${version} —— 查询/写入走 SQL 端点，触发走 action 端点，指标走 metrics 端点
set -e
CRED_FILE="\${GB_PMO_CRED:-$HOME/.gb-pmo/credentials.json}"
[ -f "$CRED_FILE" ] || { echo "未授权：先 curl -fsSL <baseUrl>/agent/login.sh | sh"; exit 1; }
BASE_URL=$(sed -n 's/.*"baseUrl":"\\([^"]*\\)".*/\\1/p' "$CRED_FILE")
TOKEN=$(sed -n 's/.*"token":"\\([^"]*\\)".*/\\1/p' "$CRED_FILE")
api() { # method path [json_body]
  local METHOD="$1" PATH_="$2" BODY="$3"
  if [ -n "$BODY" ]; then
    curl -fsS --noproxy '127.0.0.1,localhost' -X "$METHOD" "$BASE_URL$PATH_" \\
      -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$BODY"
  else
    curl -fsS --noproxy '127.0.0.1,localhost' -X "$METHOD" "$BASE_URL$PATH_" \\
      -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json'
  fi
}
case "\${1:-help}" in
  sql)       shift; api POST /api/v1/agent/sql "{\\"sql\\":\\"$(printf '%s' "$*" | sed 's/"/\\\\\\"/g')\\"}" ;;
  metrics)   api GET /api/v1/agent/metrics ;;
  metric)    shift; api POST /api/v1/agent/metrics/query "{\\"metric\\":\\"$1\\",\\"params\\":$\{2:-{}}}" ;;
  action)    shift; api POST /api/v1/agent/actions "{\\"action\\":\\"$1\\",\\"params\\":$\{2:-{}}}" ;;
  help|*)    echo "usage: client.sh sql '<SQL>' | metrics | metric <id> '<params-json>' | action <name> '<params-json>'" ;;
esac
`
}

export function renderInstallPs1(baseUrl, version) {
  // PowerShell 安装器必须纯 ASCII（BOM 会让 irm|iex 把首行当命令名）
  const b = baseUrl.replace(/'/g, "''")
  return `# gb-pmo Agent skill installer v${version}
$ErrorActionPreference = 'Stop'
$BaseUrl = if ($env:GB_PMO_BASE_URL) { $env:GB_PMO_BASE_URL } else { '${b}' }
$Name = 'gb-pmo'
$Targets = @()
if (Test-Path '.agents/skills') { $Targets += '.agents/skills/' + $Name }
$Targets += (Join-Path $env:USERPROFILE ('.agents/skills/' + $Name))
foreach ($Dir in @('.codex/skills', '.claude/skills')) {
  $P = Join-Path $env:USERPROFILE $Dir
  if (Test-Path $P) { $Targets += (Join-Path $P $Name) }
}
foreach ($T in $Targets) {
  New-Item -ItemType Directory -Force -Path $T | Out-Null
  Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/agent/skill/$Name/SKILL.md" -OutFile (Join-Path $T 'SKILL.md')
  Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/agent/skill/$Name/client.sh" -OutFile (Join-Path $T 'client.sh')
  Write-Output "installed -> $T"
}
Write-Output "skill v${version} installed; auth: iwr -UseBasicParsing ${b}/agent/login.ps1 -OutFile login.ps1; .\\login.ps1"
`
}
