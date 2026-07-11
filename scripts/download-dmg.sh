#!/bin/bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Override the update API / platform via environment if needed.
# The official API returns a JSON document whose top-level `url` field points
# to a `*.zip` bundle; swapping the `.zip` suffix for `.dmg` yields the DMG
# download address used by the build pipeline.
API_URL="${WB_UPDATE_API:-https://www.codebuddy.cn/v2/update?platform=workbuddy-darwin-x64}"
DL_DIR="$REPO_DIR/downloads"

mkdir -p "$DL_DIR"

# 若 downloads/ 中已有 DMG，则跳过下载，避免重复拉取。
if compgen -G "$DL_DIR"/*.dmg >/dev/null 2>&1; then
    echo "[download-dmg] Found existing DMG in $DL_DIR, skipping download."
    exit 0
fi

command -v curl >/dev/null 2>&1 || { echo "[download-dmg] ERROR: curl is required"; exit 1; }
command -v node  >/dev/null 2>&1 || { echo "[download-dmg] ERROR: node is required"; exit 1; }

echo "[download-dmg] Querying latest version info: $API_URL"
json="$(curl -fsSL "$API_URL")" || { echo "[download-dmg] ERROR: failed to query update API"; exit 1; }

# 从 JSON 中提取顶层 url 字段（兼容无 jq 环境，使用 node 解析）。
# url 字段为 .zip，将后缀改为 .dmg 即为 DMG 下载地址。
zip_url="$(node -e 'const j=JSON.parse(process.argv[1]||"{}");process.stdout.write(j&&j.url?j.url:"")' "$json")"
if [ -z "$zip_url" ] || [ "$zip_url" = "null" ]; then
    echo "[download-dmg] ERROR: could not parse 'url' from API response:"
    echo "$json"
    exit 1
fi

# url 字段为 .zip，将后缀改为 .dmg 即为 DMG 下载地址。
dmg_url="${zip_url%.zip}.dmg"

# 从 URL 推导文件名，保底使用固定名。
fname="$(basename "$dmg_url")"
if [ -z "$fname" ] || [ "$fname" = ".dmg" ]; then
    fname="WorkBuddy-latest.dmg"
fi

echo "[download-dmg] Resolved DMG url: $dmg_url"
echo "[download-dmg] Downloading -> $DL_DIR/$fname"
curl -fL -o "$DL_DIR/$fname" "$dmg_url" || { echo "[download-dmg] ERROR: download failed"; exit 1; }

echo "[download-dmg] Saved to $DL_DIR/$fname"
