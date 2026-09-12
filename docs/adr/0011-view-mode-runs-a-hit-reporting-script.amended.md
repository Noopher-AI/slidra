# 檢視模式也開 `allow-scripts`，為了讓作者點得到元素

> **已修訂（NOOP-90/T2）**：「Considered Options」第一項當年拒絕「父文件疊一層命中層」的理由——「算不準：transform、文字排版、filter 外擴都會讓框偏掉」——現在不成立了：runtime（selection-runtime.js）改為額外用 `getBoundingClientRect()` 精確回報每個選取元素的邊界框與祖先鏈（`bounds` 事件），父文件據此畫名稱/群組/鑽入路徑標籤與吸附輔助線，不再自己用 SVG 算框。**其餘條款原封不動仍然成立**：`sandbox="allow-scripts"`、**絕不加 `allow-same-origin`**、選取框／四角把手／框選矩形仍然畫在 iframe 的 Shadow DOM 裡（下方「選取框必須畫在 Shadow DOM 裡」那一條，只窄化成「選取框本身」，不含標籤/輔助線）、server 拒絕 `Origin: null` 的防護不變、總覽縮圖維持零 token。詳見 NOOP-90/T2 的 Plan 與 PR 說明。

作者要能點畫布上的元素把它選起來。檢視模式的 iframe 是零 token sandbox（ADR-0010），父文件因此**收不到裡面的任何一次點擊**——沒有 script、沒有 `allow-same-origin`，事件不會冒泡出來，DOM 也讀不到。這不是難做，是零可能。

決定：**檢視模式改為 `sandbox="allow-scripts"`**，隨 `srcdoc` 注入一支只做兩件事的 script——回報「被點到的是哪個元素」，以及在該元素上畫選取框。選中的識別碼經 `postMessage` 回報給父文件。**絕不加 `allow-same-origin`**，這一點與播放模式一字不差：安全模型沒有放鬆，只是把播放模式早就在用的姿態延伸到檢視模式。

**總覽縮圖維持零 token。** 縮圖 iframe 是 `pointer-events: none`，點擊落在外層的 `.overview-thumb` 按鈕上，父文件本來就收得到。這個洞只鑿在主畫布一處。

## Considered Options

- **父文件疊一層命中層**：父文件自行解析 SVG、算出每個元素的框，在 iframe 之上疊透明命中層。ADR-0010 一個字都不用改。拒絕的理由是算不準——`transform`、文字的實際排版、`filter` 的外擴都會讓框偏掉，而一個永遠對不齊內容的選取框，正好砸在這一票唯一的目標上。
- **不點畫布，改用元素清單面板**（以「顯示名稱」列出該頁元素）。同樣不動 ADR-0010，且對 agent 協作更友善。拒絕的理由只有一個：作者不能點畫面上的東西，而那正是這一票要的。此路徑仍值得未來作為並存的第二種選法。

## Consequences

- ADR-0010 中「檢視模式不需要任何 script……sandbox 維持零 token」一句，就主畫布而言由本 ADR 取代；就總覽縮圖而言仍然成立。
- `wrapSlideDocument` 不再產生純靜態文件。檢視與播放的差別從「有沒有 script」變成「注入哪一支 script」。
- **選取框必須畫在 Shadow DOM 裡。** 它活在不受信任的文件中，投影片自己的 CSS 有辦法把它蓋掉或藏起來——作者會看到「點了沒反應」。Shadow root 是讓它畫在箱子裡又不被箱子干擾的唯一便宜做法。（NOOP-90/T2 修訂：這條只約束選取框、四角把手、框選矩形——名稱/群組標籤與吸附輔助線改畫在父文件，見上方橫幅。）
- server 拒絕 `Origin: null` 的防護，現在對檢視模式同樣必要。過去這項防護與 `allow-scripts` 是「同一件事的兩半」，而那件事只發生在播放模式；現在檢視模式也需要它，任何時候都不再有「反正這個模式不跑 script」的餘地。

## 修訂（[E2.T17]：第三方嵌入播放器活在父文件）

YouTube 這類第三方播放器**不能**放進投影片的 iframe，本票實測過：

| 投影片 iframe 的 sandbox | YouTube 播放器 |
| --- | --- |
| `allow-scripts`（現行） | 完全載不起來（`embedder.identity.missing.referrer`，origin 是 `null`） |
| `allow-scripts allow-same-origin` | 正常載入 |

而 `allow-same-origin` 正是本 ADR 明文禁止的那一項：投影片文件是 `srcdoc`，加上這個 token 就與父文件同源，不受信任的投影片內容可以把自己 script 出沙盒。巢狀 iframe 的 sandbox flags 又是與父層取交集，所以「只放寬那個嵌入」在規格上做不到。

決定：**第三方嵌入的 `<iframe>` 畫在父文件**（`apps/web/src/shell/stage-overlays/EmbedLayer.tsx`），疊在投影片的佔位元素上。它載入的是真正的 https 文件，不是 `srcdoc`，因此本來就不受本 ADR 的沙盒條款約束，**投影片 iframe 的 sandbox token 一個字都沒有改**。

幾何一律由 runtime 用 `getBoundingClientRect()` 回報（`embed-boxes` 事件，兩支 runtime 各有一份），父文件只做座標系換算——與上方 NOOP-90/T2 修訂對 `bounds` 的處理是同一條規則的再一次套用，父文件不自己算 SVG 的框。

`family="media"` 的效果照樣打得到嵌入：runtime 沒有 `<video>` 可以呼叫 `.play()`，改成把意圖轉發出去（`embed-command` 事件），由父文件說播放器自己的協定。這裡用的是 YouTube 官方的 IFrame Player API（`YT.Player`）——實測過土法 `postMessage` 送 `{"event":"command","func":"playVideo"}` 給 `?enablejsapi=1` 的 frame 完全沒有回應，那個 handshake 的形狀是 YouTube 私有且會變的。第三方腳本只在投影片真的帶了 YouTube 嵌入時才延遲載入。

### Consequences

- 這一層是 `stage-overlays/` 底下**唯一**在播放模式仍然掛著的疊層（`Stage.tsx` 的 `shellVisible` 閘門之外）：嵌入的影片必須在播放與全螢幕下繼續播。
- 檢視模式下嵌入的 iframe 是 `pointer-events: none`，否則作者點不到自己的元素、選不起來；播放模式才交還點擊給播放器。
- 嵌入用到一支第三方腳本（`https://www.youtube.com/iframe_api`）。載不起來時嵌入照常顯示、觀眾仍可按播放器自己的播放鈕，只有「效果驅動播放」這一項失效——這不是損毀的投影片，所以不報錯。
- 嵌入需要外網。離線播放時該元素只剩一個透明佔位框——`data-slidra-media` 存的是播放器網址，沒有位元組被收進 `.slidra` 容器。
