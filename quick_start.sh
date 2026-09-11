#!/usr/bin/env bash
#
# quick_start.sh — 一鍵啟動 CoMotion 前端，供人工驗收使用。
#
# 它做的事：
#   1. 同步相依套件（含各 workspace 的新增相依）
#   2. 建置 server（tsc -b）與 web（vite build），以及 Rust 二進位
#   3. 檢查前置條件（建置產物、CLI 執行檔、agent adapter）
#   4. 準備簡報（示範簡報，或 --blank 的空白簡報）
#   5. 執行 co-motion serve，開瀏覽器看畫面
#
# 兩種簡報準備方式：
#   - 預設（不加旗標）：把 demo/ 打包成示範簡報，四頁投影片、三個資產（圖、
#     影片、音檔），其中兩頁帶效果清單。用來驗**既有行為沒壞**——換頁、資產、
#     播放、效果、倒退、全螢幕這些都需要現成內容才驗得到。想改驗收素材就改
#     demo/，然後用 --fresh 重跑。
#   - --blank：建立一份全新的空白簡報。用來驗**從零開始的路徑**——新簡報建立、
#     第一次插入元素、空狀態畫面、agent 對一份空簡報下第一道命令。
#
# 用法：
#   ./quick_start.sh                      # 全自動，示範簡報
#   ./quick_start.sh --blank              # 全自動，空白簡報
#   ./quick_start.sh --port 6000          # 換連接埠
#   ./quick_start.sh --agent claude       # 指定 agent（偵測到多個時建議加）
#   ./quick_start.sh --fresh              # 丟掉舊簡報，重新建立
#   ./quick_start.sh --skip-build         # 跳過建置（只改前端原始碼時不要用）
#   ./quick_start.sh --open               # 順便開瀏覽器（預設不開）
#   ./quick_start.sh --no-open            # 保留給既有指令；已是預設行為
#   ./quick_start.sh --qa --no-open       # 沙箱 QA 層：背景起 serve + headless
#                                         #   Chromium，寫出 browser-use 用的 env 檔
#   ./quick_start.sh --qa-stop            # 收掉 --qa 留下的背景 serve 與 Chromium

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

PORT=5173
AGENT=""
FRESH=0
SKIP_BUILD=0
# 預設不開瀏覽器：這個腳本常常是重跑的（改一行、重跑驗證、再改一行），每次都
# 彈一個新分頁出來，最後累積一堆指向同一個網址、其中大多數還是過期簡報識別碼的
# 分頁。要開就自己加 --open。
OPEN_BROWSER=0
BLANK=0
QA=0
QA_STOP=0

while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="${2:?--port 缺少值}"; shift 2 ;;
    --agent) AGENT="${2:?--agent 缺少值}"; shift 2 ;;
    --fresh) FRESH=1; shift ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --open) OPEN_BROWSER=1; shift ;;
    # 已是預設，保留旗標本身以免既有指令與文件（qa/README.md）壞掉。
    --no-open) OPEN_BROWSER=0; shift ;;
    --blank) BLANK=1; shift ;;
    --qa) QA=1; shift ;;
    --qa-stop) QA_STOP=1; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "未知的參數：$1" >&2; exit 1 ;;
  esac
done

CLI="$ROOT/node_modules/.bin/co-motion"
DEMO_SOURCE="$ROOT/demo"
DEMO_DIR="$ROOT/.quickstart"
DEMO_COMOT="$DEMO_DIR/demo.comot"
DEMO_ID_FILE="$DEMO_DIR/presentation-id"
BLANK_COMOT="$DEMO_DIR/blank.comot"
BLANK_ID_FILE="$DEMO_DIR/blank-presentation-id"

step() { printf '\n\033[1;36m▸ %s\033[0m\n' "$1"; }

# --qa / --qa-stop 共用狀態 ---------------------------------------------------
# 沙箱 QA 層：--qa 在既有流程（1~4 步）之後另外背景起一份 serve + headless
# Chromium，供 browser-use 操作；--qa-stop 收掉它們。這兩個旗標不影響 1~4 步
# 的任何行為。
QA_DIR="$ROOT/.quickstart/qa"
QA_SERVE_PGID_FILE="$QA_DIR/serve.pgid"
QA_CHROMIUM_PGID_FILE="$QA_DIR/chromium.pgid"
QA_ENV_FILE="$QA_DIR/qa.env"
QA_SERVE_LOG="$QA_DIR/serve.log"
QA_CDP_PORT="${CO_MOTION_QA_CDP_PORT:-9222}"

# 收掉一個 pgid 檔記錄的行程群組：TERM，等最多 5 秒，還活著就 KILL。
# co-motion serve 是 spawn 出一個獨立的 node 子行程（不是 exec），所以
# 只殺 wrapper 收不掉 server；--qa 用 setsid 起、記整個行程群組的 PGID，
# 這裡對整組送信號才收得乾淨。
qa_kill_pgid_file() {
  local pgid_file="$1"
  [ -f "$pgid_file" ] || return 1
  local pgid
  pgid="$(cat "$pgid_file")"
  if [ -n "$pgid" ] && kill -0 -- "-$pgid" 2>/dev/null; then
    kill -TERM -- "-$pgid" 2>/dev/null || true
    local waited=0
    while [ "$waited" -lt 5 ] && kill -0 -- "-$pgid" 2>/dev/null; do
      sleep 1
      waited=$((waited + 1))
    done
    kill -0 -- "-$pgid" 2>/dev/null && kill -KILL -- "-$pgid" 2>/dev/null || true
  fi
  rm -f "$pgid_file"
  return 0
}

# 收尾指令不該因為「已經收乾淨」而失敗，所以永遠以 0 結束。
qa_stop() {
  local found=0
  qa_kill_pgid_file "$QA_SERVE_PGID_FILE" && found=1
  qa_kill_pgid_file "$QA_CHROMIUM_PGID_FILE" && found=1
  rm -f "$QA_ENV_FILE"
  if [ "$found" -eq 0 ]; then
    echo "沒有在跑的 QA 環境。"
  else
    echo "QA 環境已收掉。"
  fi
}

if [ "$QA_STOP" -eq 1 ] && [ "$QA" -eq 0 ]; then
  qa_stop
  exit 0
fi

if [ "$QA" -eq 1 ]; then
  # 在花時間 build 之前先確認 browser-use 在 PATH 上——它由工作區的 sandbox
  # tools mount（/opt/sandbox）提供，不是 npm 相依、不是本專案 Dockerfile
  # 的責任，缺了也不該讓人等完整個 build 才看到這行錯誤。
  if ! command -v browser-use >/dev/null 2>&1; then
    echo "找不到 browser-use：它應由工作區的 sandbox tools mount（/opt/sandbox）提供，不是本專案的 npm 相依，也不是 .devcontainer/Dockerfile 的責任。請確認執行環境掛載了 /opt/sandbox。" >&2
    exit 1
  fi
  if [ "$QA_STOP" -eq 1 ]; then
    # 與 --qa 同時給：視為「先停再起」。
    qa_stop
  elif [ -f "$QA_SERVE_PGID_FILE" ] || [ -f "$QA_CHROMIUM_PGID_FILE" ]; then
    echo "偵測到既有的 QA 環境，先收掉再重新啟動。" >&2
    qa_stop
  fi
  mkdir -p "$QA_DIR"
fi

# 1. 相依套件 ---------------------------------------------------------------
# 切換分支可能只改 workspace 的 package.json 或 lockfile；node_modules
# 目錄的時間戳也不能證明上次安裝已完成。交由 npm 同步整個相依樹。
step "同步相依套件"
npm install

# 2. 建置 -------------------------------------------------------------------
# serve 只吃 packages/web/dist 的靜態檔，沒有 dev server proxy（ADR-0002），
# 所以前端每次改動都必須重新 build 才看得到。
if [ "$SKIP_BUILD" -eq 0 ]; then
  step "建置 server / web / Rust CLI"
  npm run build
fi

if [ ! -f "$ROOT/packages/web/dist/index.html" ]; then
  echo "packages/web/dist 不存在，請先執行 npm run build（或不要加 --skip-build 重跑）。" >&2
  exit 1
fi

# 3. 前置檢查 -----------------------------------------------------------------
# NOOP-278：node_modules/.bin/co-motion 是 npm run build 最後一步
# （scripts/link-cli.mjs）指到 Rust 產物（target/release/co-motion）的連結，
# 現在只由 scripts/link-cli.mjs 建立。
if [ ! -x "$CLI" ]; then
  echo "找不到可執行的 node_modules/.bin/co-motion（應指向 cargo build 產出的 target/release/co-motion）。請執行 npm run build 後重試。" >&2
  exit 1
fi

step "檢查 agent"
# NOOP-230：兩個 adapter（claude-code-acp／codex-acp）現在是 @co-motion/server
# 的一般 npm 相依，隨第 1 步的 npm install 一起裝好，不用再另外全域安裝、也
# 不用探測 PATH。「要用哪一個」改成使用者層級設定（settings.json）或
# --agent 這次覆蓋一次，沒選時 serve 照常啟動，只是聊天功能要等選定才能用。
if [ -n "$AGENT" ] && [ "$AGENT" != "claude" ] && [ "$AGENT" != "codex" ]; then
  echo "--agent 必須是 claude 或 codex。" >&2
  exit 1
fi

# 4. 簡報 ---------------------------------------------------------------------
if [ "$FRESH" -eq 1 ]; then
  rm -rf "$DEMO_DIR"
fi
mkdir -p "$DEMO_DIR"

if [ "$BLANK" -eq 1 ]; then
  if [ ! -f "$BLANK_COMOT" ]; then
    step "建立空白簡報"
    "$CLI" new "$BLANK_COMOT" --name "空白簡報"
  fi

  if [ ! -s "$BLANK_ID_FILE" ]; then
    step "開啟空白簡報，取得識別碼"
    # open 先印一行訊息，再印 { "id": "..." }；只取 id 欄位。
    "$CLI" open "$BLANK_COMOT" \
      | grep -o '"id"[[:space:]]*:[[:space:]]*"[^"]*"' \
      | sed 's/.*"\([^"]*\)"$/\1/' > "$BLANK_ID_FILE"
  fi

  PRESENTATION_ID="$(cat "$BLANK_ID_FILE")"
  if [ -z "$PRESENTATION_ID" ]; then
    echo "無法取得簡報識別碼，請用 --fresh 重跑。" >&2
    exit 1
  fi
else
  # demo/ 比打包出來的 .comot 新，代表素材改過了。人工驗收路徑不自動重打包——
  # 重打包就得重新 open，會換一組簡報識別碼，把使用者手上的網址與終端機指令
  # 都作廢。
  #
  # NOOP-349：--qa 沒有這個顧慮（每次都重寫 QA 環境變數檔裡的
  # CO_MOTION_QA_PRESENTATION_ID，沒有人手上握著舊網址），而過期的 deck 在
  # QA 路徑上是災難：agent 會對著舊素材跑案例腳本，拿到的 PASS/FAIL 全部
  # 對應到錯的簡報內容，而唯一的線索只有下面這行 stderr 提醒。#294 就是這樣
  # 連續五輪對著一份含滿版背景 rect 的舊 demo 跑 F-15，把「拖曳空白」永遠
  # 判成 move 手勢的環境問題，誤診成 browser-use／CDP 的不穩定。所以 --qa
  # 直接重打包，不留讓人踩過去的餘地。
  if [ -f "$DEMO_COMOT" ] && [ -n "$(find "$DEMO_SOURCE" -newer "$DEMO_COMOT" -type f -print -quit)" ]; then
    if [ "$QA" -eq 1 ]; then
      step "demo/ 比示範簡報新，重新打包（--qa）"
      rm -f "$DEMO_COMOT" "$DEMO_ID_FILE"
    else
      echo "提醒：demo/ 已被修改，但示範簡報還是舊的，要套用請加 --fresh 重跑。" >&2
    fi
  fi

  if [ ! -f "$DEMO_COMOT" ]; then
    step "打包示範簡報（demo/ → .comot）"
    # 把一個目錄打包成 .comot 沒有對應的 CLI 命令（見 docs/spec/cli.md 的
    # `pack` 條目——那是打包一份已開啟的簡報，不是任意目錄），所以直接呼叫
    # scripts/pack-directory.mjs。
    node "$ROOT/scripts/pack-directory.mjs" "$DEMO_SOURCE" "$DEMO_COMOT"
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
fi

# 5. 啟動 -------------------------------------------------------------------
SERVE_ARGS=("serve" "$PRESENTATION_ID" "--port" "$PORT")
if [ -n "$AGENT" ]; then
  SERVE_ARGS+=("--agent" "$AGENT")
fi

# agent 執行的是 `co-motion ...`（編輯規約裡就是這樣寫的），它的 shell 從
# serve 行程繼承環境變數。專案沒有全域安裝 CLI，所以必須把 workspace 的
# node_modules/.bin 掛進 PATH——少了這一步，agent 會拿到
# 「command not found: co-motion」而完全改不動簡報。
export PATH="$ROOT/node_modules/.bin:$PATH"

step "驗證 PATH"
RESOLVED="$(command -v co-motion || true)"
if [ "$RESOLVED" != "$CLI" ]; then
  echo "PATH 修正失敗：co-motion 解析到「${RESOLVED:-（找不到）}」，預期是 ${CLI}。" >&2
  exit 1
fi
# co-motion 沒有 --help；用不帶參數呼叫來確認它真的執行了（Rust 二進位自己印出
# 「缺少命令名稱」並以非 0 結束，不再回退給 Node），而不是被 shell 當成
# command not found。
INVOKE_OUTPUT="$(co-motion 2>&1 || true)"
if printf '%s' "$INVOKE_OUTPUT" | grep -qi "command not found"; then
  echo "co-motion 執行失敗，agent 會拿到 command not found。" >&2
  exit 1
fi
echo "co-motion 已可用：$RESOLVED"

URL="http://127.0.0.1:$PORT"

if [ "$QA" -eq 1 ]; then
  : # --qa 不印人工驗收清單（下面走的是背景啟動路徑，見腳本尾端）。
elif [ "$BLANK" -eq 1 ]; then
  cat <<INFO

簡報識別碼：$PRESENTATION_ID
簡報檔：    $BLANK_COMOT
網址：      $URL

驗收清單（空白簡報，驗從零開始的路徑）：
  - 畫面開到一份空白簡報，沒有任何投影片（新簡報零頁，ADR-0018），顯示「此簡報沒有投影片」。
  - 按 New → From outline… 貼一份大綱送出：訊息以 /comotion-plan 開頭，agent 寫出
    plan/outline.md 與 plan/design-spec.md 後，編輯器彈出擋住式的計畫確認視窗。
  - 視窗裡每題預設是 agent 的建議，可切換或自由填寫；按「確認並建置」後 agent 走
    /comotion-build 從第 1 頁建出整份、登記範本、用 co-motion validate 修到 0 錯誤。
  - 在聊天框輸入一道建立元素的指令（例如「加一個標題文字」），agent 會經 CLI
    改檔，畫面自動更新出現這個元素——這是這份簡報第一次被下命令。
  - 從終端機看同一份內容：
      node_modules/.bin/co-motion cat $PRESENTATION_ID project.json

其他：
  - 按 Ctrl+C 結束。

INFO
else
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
  倒退播放 #46（接著上面的第 4 頁最後一步，一路按方向鍵左）
    - 按一次方向鍵左：只退回「音檔開始播放」的前一步，畫面仍在第 4 頁，
      影片畫面與喇叭旁白都會消失（不是暫停，是整個拿掉），沒有任何聲音。
    - 再按一次：退到「說明文字淡入」那一步本身，仍在第 4 頁。
    - 再按一次：跨頁退回第 3 頁，而且第 3 頁是「整頁跑完」的樣子——
      「步驟一」「步驟二」「步驟三」三行文字全部可見，不是第 3 頁剛進來
      的空白開頭。
    - 在第 3 頁再按一次方向鍵左：只有「步驟三」消失，「步驟一」「步驟二」
      仍然可見——確認是一次只退一步，不是整頁重來。
    - 繼續按方向鍵左，會依序退回第 2 頁、第 1 頁；沒有效果清單的頁面一按
      就整頁跨過去。
    - 退到第 1 頁最一開始時，再按方向鍵左：畫面不動、不當機。
    - 整個倒退過程：畫面全程沒有跳出任何錯誤訊息，也沒有任何影片或音檔
      還在播放。

其他：
  - 從終端機看同一份內容：
      node_modules/.bin/co-motion cat $PRESENTATION_ID slides/001.svg
  - 按 Ctrl+C 結束。

INFO
fi

if [ "$QA" -eq 0 ] && [ "$OPEN_BROWSER" -eq 1 ] && command -v open >/dev/null 2>&1; then
  # serve 綁定成功後才開瀏覽器，避免開到一個還沒起來的頁面。
  ( sleep 2; open "$URL" ) &
fi

# 5. 啟動 ---------------------------------------------------------------------
if [ "$QA" -eq 0 ]; then
  step "啟動 co-motion serve"
  exec "$CLI" "${SERVE_ARGS[@]}"
fi

# --qa：背景起 serve，輪詢直到有回應，再起 headless Chromium，最後寫 env 檔並
# 跑 browser-use --doctor 冒煙測試。與不帶 --qa 的路徑不同，這裡必須讓腳本
# 自己結束（父票驗收條件 1：「一個指令跑完」），所以不能用 exec。
step "啟動 co-motion serve（QA，背景）"

qa_wait_http() {
  local url="$1" timeout_s="$2" waited=0
  while [ "$waited" -lt "$timeout_s" ]; do
    local code
    code="$(curl -s -o /dev/null -w '%{http_code}' "$url" 2>/dev/null || true)"
    [ "$code" = "200" ] && return 0
    sleep 1
    waited=$((waited + 1))
  done
  return 1
}

setsid bash -c '
  echo $$ > "$1"
  shift
  exec "$@"
' _ "$QA_SERVE_PGID_FILE" "$CLI" "${SERVE_ARGS[@]}" > "$QA_SERVE_LOG" 2>&1 &
disown

if ! qa_wait_http "$URL/" 60; then
  echo "co-motion serve 在 60 秒內沒有回應 $URL/。serve.log 最後 20 行：" >&2
  tail -n 20 "$QA_SERVE_LOG" >&2 || true
  exit 1
fi
echo "serve 已就緒：$URL"

step "解析 Chromium 路徑"
CHROMIUM="$(node -e "console.log(require('playwright').chromium.executablePath())")"
if [ ! -x "$CHROMIUM" ]; then
  echo "Chromium 執行檔不存在或不可執行：${CHROMIUM}。請執行 npx playwright install chromium 後重試。" >&2
  exit 1
fi
echo "Chromium：$CHROMIUM"

step "啟動 headless Chromium（QA，背景）"
if curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$QA_CDP_PORT/json/version" 2>/dev/null | grep -q '^200$'; then
  echo "CDP port $QA_CDP_PORT 已被佔用。改用 CO_MOTION_QA_CDP_PORT 環境變數指定別的 port。" >&2
  exit 1
fi

CHROMIUM_PROFILE_DIR="$QA_DIR/profile"
mkdir -p "$CHROMIUM_PROFILE_DIR"
CHROMIUM_LOG="$QA_DIR/chromium.log"

setsid bash -c '
  echo $$ > "$1"
  shift
  exec "$@"
' _ "$QA_CHROMIUM_PGID_FILE" "$CHROMIUM" \
  --headless=new --no-sandbox \
  "--remote-debugging-port=$QA_CDP_PORT" \
  --window-size=1440,900 \
  "--user-data-dir=$CHROMIUM_PROFILE_DIR" \
  --disable-dev-shm-usage \
  --disable-background-timer-throttling \
  --disable-backgrounding-occluded-windows \
  --disable-renderer-backgrounding \
  about:blank > "$CHROMIUM_LOG" 2>&1 &
disown

if ! qa_wait_http "http://127.0.0.1:$QA_CDP_PORT/json/version" 30; then
  echo "Chromium 在 30 秒內沒有開放 CDP port ${QA_CDP_PORT}。chromium.log 最後 20 行：" >&2
  tail -n 20 "$CHROMIUM_LOG" >&2 || true
  exit 1
fi
echo "Chromium CDP 已就緒：127.0.0.1:$QA_CDP_PORT"

step "寫出 QA env 檔"
cat > "$QA_ENV_FILE" <<ENV
export BU_CDP_URL="http://127.0.0.1:$QA_CDP_PORT"
export BH_AGENT_WORKSPACE="$ROOT/qa"
export CO_MOTION_QA_URL="$URL"
export CO_MOTION_QA_PRESENTATION_ID="$PRESENTATION_ID"
export BH_RUNTIME_DIR="/tmp/co-motion-qa-$(id -u)"
export BH_TMP_DIR="$QA_DIR/tmp"
export CO_MOTION_QA_CDP_PORT="$QA_CDP_PORT"
ENV
mkdir -p "$QA_DIR/tmp"
echo "已寫出：$QA_ENV_FILE"

step "開啟 CoMotion（透過 qa/agent_helpers.py 的 open_deck()）"
# `browser-use --doctor` 是唯讀診斷，本身不會啟動 daemon（daemon 只在跑一般腳本時
# 由 ensure_daemon() 啟動，見 browser_harness/run.py）。父票驗收條件要求 doctor
# 印出「active page 是 CoMotion」，所以這裡先跑一段會導覽到 CO_MOTION_QA_URL 的腳本
# ——同時完成「啟動 daemon」與「開到 CoMotion」兩件事，再進 doctor 檢查。
set +e
DOCTOR_OPEN_OUTPUT="$( set -a; source "$QA_ENV_FILE"; set +a; browser-use <<'PY' 2>&1
print(open_deck())
PY
)"
DOCTOR_OPEN_RC=$?
set -e
if [ "$DOCTOR_OPEN_RC" -ne 0 ]; then
  echo "開啟 CoMotion 失敗（離開碼 ${DOCTOR_OPEN_RC}）：" >&2
  echo "$DOCTOR_OPEN_OUTPUT" >&2
  echo "QA 環境已保留（.quickstart/qa/），可用 --qa-stop 收掉，或依上面的輸出排查後重跑。" >&2
  exit "$DOCTOR_OPEN_RC"
fi
echo "$DOCTOR_OPEN_OUTPUT"

step "browser-use --doctor"
set +e
( set -a; source "$QA_ENV_FILE"; set +a; browser-use --doctor )
DOCTOR_RC=$?
set -e

if [ "$DOCTOR_RC" -ne 0 ]; then
  echo "browser-use --doctor 回報異常（離開碼 ${DOCTOR_RC}）。QA 環境已保留（.quickstart/qa/），可用 --qa-stop 收掉，或依上面的輸出排查後重跑。" >&2
  exit "$DOCTOR_RC"
fi

cat <<QAINFO

QA 環境已就緒。
  source $QA_ENV_FILE
  browser-use < qa/cases/smoke.py

收尾：
  ./quick_start.sh --qa-stop

QAINFO
