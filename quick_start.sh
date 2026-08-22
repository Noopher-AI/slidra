#!/usr/bin/env bash
#
# quick_start.sh — 一鍵啟動 CoMotion 前端，供人工驗收使用。
#
# 它做的事：
#   1. 安裝相依套件（node_modules 不存在時）
#   2. 建置 core / cli / server（tsc -b）與 web（vite build）
#   3. 準備一份示範簡報（.comot），取得簡報識別碼
#   4. 執行 co-motion serve，開瀏覽器看畫面
#
# 用法：
#   ./quick_start.sh                      # 全自動
#   ./quick_start.sh --port 6000          # 換連接埠
#   ./quick_start.sh --agent claude       # 指定 agent（偵測到多個時必填）
#   ./quick_start.sh --fresh              # 丟掉舊示範簡報，重新建立
#   ./quick_start.sh --skip-build         # 跳過建置（只改前端原始碼時不要用）
#   ./quick_start.sh --no-open            # 不要自動開瀏覽器

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

PORT=5173
AGENT=""
FRESH=0
SKIP_BUILD=0
OPEN_BROWSER=1

while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="${2:?--port 缺少值}"; shift 2 ;;
    --agent) AGENT="${2:?--agent 缺少值}"; shift 2 ;;
    --fresh) FRESH=1; shift ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --no-open) OPEN_BROWSER=0; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "未知的參數：$1" >&2; exit 1 ;;
  esac
done

CLI="$ROOT/node_modules/.bin/co-motion"
DEMO_DIR="$ROOT/.quickstart"
DEMO_COMOT="$DEMO_DIR/demo.comot"
DEMO_ID_FILE="$DEMO_DIR/presentation-id"

step() { printf '\n\033[1;36m▸ %s\033[0m\n' "$1"; }

# 1. 相依套件 ---------------------------------------------------------------
if [ ! -d "$ROOT/node_modules" ]; then
  step "安裝相依套件"
  npm install
fi

# 2. 建置 -------------------------------------------------------------------
# serve 只吃 packages/web/dist 的靜態檔，沒有 dev server proxy（ADR-0002），
# 所以前端每次改動都必須重新 build 才看得到。
if [ "$SKIP_BUILD" -eq 0 ]; then
  step "建置 core / cli / server / web"
  npm run build
fi

if [ ! -f "$ROOT/packages/web/dist/index.html" ]; then
  echo "找不到 packages/web/dist/index.html，請先執行不帶 --skip-build 的建置。" >&2
  exit 1
fi

# 3. 示範簡報 ---------------------------------------------------------------
if [ "$FRESH" -eq 1 ]; then
  rm -rf "$DEMO_DIR"
fi
mkdir -p "$DEMO_DIR"

if [ ! -f "$DEMO_COMOT" ]; then
  step "建立示範簡報"
  "$CLI" new "$DEMO_COMOT" --name "驗收用簡報"
fi

if [ ! -s "$DEMO_ID_FILE" ]; then
  step "開啟示範簡報，取得識別碼"
  # open 先印一行訊息，再印 { "id": "..." }；只取 id 欄位。
  "$CLI" open "$DEMO_COMOT" \
    | grep -o '"id"[[:space:]]*:[[:space:]]*"[^"]*"' \
    | sed 's/.*"\([^"]*\)"$/\1/' > "$DEMO_ID_FILE"
fi

PRESENTATION_ID="$(cat "$DEMO_ID_FILE")"
if [ -z "$PRESENTATION_ID" ]; then
  echo "無法取得簡報識別碼，請用 --fresh 重跑。" >&2
  exit 1
fi

# 4. 啟動 -------------------------------------------------------------------
SERVE_ARGS=("serve" "$PRESENTATION_ID" "--port" "$PORT")
if [ -n "$AGENT" ]; then
  SERVE_ARGS+=("--agent" "$AGENT")
fi

# agent 執行的是 `co-motion ...`（編輯規約裡就是這樣寫的），它的 shell 從
# serve 行程繼承環境變數。專案沒有全域安裝 CLI，所以必須把 workspace 的
# node_modules/.bin 掛進 PATH——少了這一步，agent 會拿到
# 「command not found: co-motion」而完全改不動簡報。
export PATH="$ROOT/node_modules/.bin:$PATH"

URL="http://127.0.0.1:$PORT"
cat <<INFO

簡報識別碼：$PRESENTATION_ID
示範簡報檔：$DEMO_COMOT
網址：      $URL

驗收提示：
  - 畫面上應該看到一張標題為「驗收用簡報」的投影片。
  - 在聊天框輸入「把標題改成 Q3 財報」，agent 會經 CLI 改檔，畫面自動更新。
  - agent 執行命令時畫面不會顯示工具進度，看起來像停住是正常的，等它回話即可。
  - 想從終端機驗證同一份內容：
      node_modules/.bin/co-motion cat $PRESENTATION_ID slides/001.svg
  - 按 Ctrl+C 結束。

INFO

if [ "$OPEN_BROWSER" -eq 1 ] && command -v open >/dev/null 2>&1; then
  # serve 綁定成功後才開瀏覽器，避免開到一個還沒起來的頁面。
  ( sleep 2; open "$URL" ) &
fi

step "啟動 co-motion serve"
exec "$CLI" "${SERVE_ARGS[@]}"
