#!/usr/bin/env bash
#
# quick_start.sh — 一鍵啟動 CoMotion 前端，供人工驗收使用。
#
# 它做的事：
#   1. 安裝相依套件（node_modules 不存在時）
#   2. 建置 core / cli / server（tsc -b）與 web（vite build）
#   3. 把 demo/ 打包成示範簡報（.comot），取得簡報識別碼
#   4. 執行 co-motion serve，開瀏覽器看畫面
#
# 示範簡報的內容就是 repo 裡的 demo/：四頁投影片、三個資產（圖、影片、音檔），
# 其中兩頁帶效果清單。想改驗收素材就改那裡，然後用 --fresh 重跑。
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
DEMO_SOURCE="$ROOT/demo"
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

# demo/ 比打包出來的 .comot 新，代表素材改過了。這裡不自動重打包——重打包就得
# 重新 open，會換一組簡報識別碼，把使用者手上的網址與終端機指令都作廢。
if [ -f "$DEMO_COMOT" ] && [ -n "$(find "$DEMO_SOURCE" -newer "$DEMO_COMOT" -type f -print -quit)" ]; then
  echo "提醒：demo/ 已被修改，但示範簡報還是舊的，要套用請加 --fresh 重跑。" >&2
fi

if [ ! -f "$DEMO_COMOT" ]; then
  step "打包示範簡報（demo/ → .comot）"
  # packDirectory 只在 core 有，還沒有對應的 CLI 命令，所以直接呼叫它。
  node --input-type=module -e '
    import { packDirectory } from "@co-motion/core";
    await packDirectory(process.argv[1], process.argv[2]);
  ' "$DEMO_SOURCE" "$DEMO_COMOT"
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

驗收清單（這一輪做完的部分）：
  換頁 #25
    - 畫面上是第 1 頁「驗收用簡報」，右下角顯示 1 / 4。
    - 按 › 或方向鍵右到第 2、3、4 頁；到底時按鈕變灰、再按不動也不當機。
    - 游標在聊天輸入框裡時按方向鍵，應該是移動游標，不會翻頁。
  資產 #11 / #13
    - 第 2 頁的藍色方塊圖有畫出來（相對路徑經 <base> 轉到 /api/raw/）。
    - Range 請求要回 206 與 Content-Range：
        curl -si -H 'Range: bytes=0-9' $URL/api/raw/assets/photo.svg | head -5
    - 壞掉的 Range 要回 416：
        curl -si -H 'Range: bytes=99999999-' $URL/api/raw/assets/photo.svg | head -3
  即時預覽 #5
    - 另開一個終端機改內容，畫面應該不重整就更新，且停在你正在看的那一頁：
        node_modules/.bin/co-motion text set $PRESENTATION_ID slides/001.svg el-title "Q3 財報"
  agent 對話 #6
    - 在聊天框輸入「把第一頁標題改成 Q3 財報」，agent 會經 CLI 改檔，畫面自動更新。
    - agent 執行命令時畫面不會顯示工具進度，看起來像停住是正常的，等它回話即可。
  總覽 #27
    - 左側依序看到每一頁的真實縮圖，點一下跳到那一頁，目前那一頁看得出來。
  播放模式 #28
    - 翻到第 1 頁，按「播放」：從頭開始一路按方向鍵右，不必離開畫面。
    - 第 1、2 頁沒有效果清單，按一次方向鍵右直接換到下一頁。
    - 第 3 頁（有效果清單那頁）：畫面立刻不會閃過完整內容——「步驟一」
      「步驟二」「步驟三」三行文字一開始就是隱藏的，標題維持可見。
      按方向鍵右，三行文字依序出現，每按一次只出現一行；按完三步後再按
      一次會換到第 4 頁。
    - 按方向鍵左：不會倒退任何一步。
    - 點畫面別處（例如聊天輸入框）搶走焦點，畫面應明確提示「焦點不在播放器上」，
      並提供一顆點回去的按鈕。
    - 按「離開播放」回到檢視模式，這時方向鍵才會重新翻頁而不是推進步驟。
  全螢幕開關 #29
    - 播放模式下，畫面上會有一顆「全螢幕」按鈕（檢視模式沒有這顆按鈕）。
    - 按下去整個播放畫面（含控制列）撐滿螢幕，按鈕文字變成「退出全螢幕」；
      方向鍵推進、按鈕點擊在全螢幕狀態下都照常可用。
    - 按 Esc 或再按一次按鈕，回到內嵌播放，不會掉出播放模式。
  影音效果 #30（第 4 頁）
    - 從第 3 頁按完三步、再按一次方向鍵右，換到第 4 頁「影音」。
    - 說明文字「重點說明」一開始是隱藏的，按方向鍵右淡入出現。
    - 再按一次，影片色塊換成真的在播放的影片畫面，對齊原本佔位色塊的位置。
    - 再按一次，喇叭圖示旁開始播放旁白音檔（沒有畫面變化，但可從瀏覽器分頁
      的靜音圖示或開發者工具的 Elements 面板看到多了一個 <audio> 在播放）。
    - 此時已是整份簡報的最後一步，再按方向鍵右不動、不當機。

其他：
  - 從終端機看同一份內容：
      node_modules/.bin/co-motion cat $PRESENTATION_ID slides/001.svg
  - 按 Ctrl+C 結束。

INFO

if [ "$OPEN_BROWSER" -eq 1 ] && command -v open >/dev/null 2>&1; then
  # serve 綁定成功後才開瀏覽器，避免開到一個還沒起來的頁面。
  ( sleep 2; open "$URL" ) &
fi

step "啟動 co-motion serve"
exec "$CLI" "${SERVE_ARGS[@]}"
