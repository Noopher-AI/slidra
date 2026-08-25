# 投影片內容不可信：檢視不跑 script，播放才開 `allow-scripts`

> **⚠️ 部分條款已失效。** 全螢幕的目標元素由 `#29` 的實作修訂：改成對包住 iframe 與播放控制列的**容器**
> 呼叫 `requestFullscreen()`，不再是 iframe 元素本身。詳見下文原處的註記。
>
> **仍然成立的**：投影片內容一律不可信、檢視模式不跑 script、播放模式才加 `allow-scripts`、
> 永遠不加 `allow-same-origin`、server 必須拒絕 `Origin: null`、不採用伺服器端消毒。

`.comot` 的用途之一就是被作者以外的人打開（ADR-0003）。合法的 SVG 可以帶 `onload`、`onerror` 等事件處理器，若以第一方身分執行，就能取用 `/api/*` 並把整份簡報送出去。投影片內容因此一律視為不可信。

投影片渲染在 sandbox iframe 中，以 `srcdoc` 餵入，處於 opaque origin。這個姿態依模式而異：

- **檢視模式不需要任何 script。** ADR 決定投影片的靜態長相就是所有效果都跑完的最終狀態（隱藏由 runtime 在播放時施加，不寫進檔案），所以瀏覽器自己就畫得出正確畫面。sandbox 維持零 token。總覽的縮圖同樣如此。
- **播放模式才加 `allow-scripts`**，runtime 隨 `srcdoc` 一起注入。**絕不加 `allow-same-origin`**：兩者並存時，iframe 內的 script 可以自行解除 sandbox，比只加其中一個都糟。

鍵盤必須由 runtime 在 iframe 內自行監聽。transient activation 不會透過 `postMessage` 傳遞（曾有委派提案，因濫用疑慮被擋下），因此「父文件收到方向鍵後轉發給 iframe 播放音訊」會以 `NotAllowedError` 失敗。焦點不在播放器上時，畫面必須明確說明並提供點回去的方式，絕不無聲失效——半數步驟能動、半數不能，比壞掉更糟。

## Consequences

- 切換 sandbox 屬性需要重建 iframe，因此進入播放是一次重新載入，而非原地切換。
- opaque origin 仍可送出跨源的簡單請求（讀不到回應，但寫得出去）。server 必須拒絕 `Origin: null` 的請求，這項防護與開啟 `allow-scripts` 是同一件事的兩半，不可分開實作。
- 播放器與側邊欄之間的狀態只能經由 `postMessage` 溝通。
- 全螢幕由父文件對 iframe 元素本身呼叫 `requestFullscreen()`，不授予 sandbox 任何全螢幕權限。此路徑在 opaque origin 下的行為應以實測確認，不得僅憑規格假定。

> **全螢幕目標已由 #29 的實作修訂：改成對包住 iframe 與播放控制列的容器元素呼叫 `requestFullscreen()`，不再是 iframe 元素本身。** 對 iframe 本身全螢幕會讓它單獨進入瀏覽器的 top layer，父文件裡的任何元素（包含全螢幕開關、離開播放按鈕本身）都變得完全點不到——實測結果是真實的 Playwright click 逾時，瀏覽器回報 `intercepts pointer events`。改成對容器全螢幕後，播放控制列的按鈕是容器的後代，留在同一個 top layer 裡，才能被真實點擊。#24 的實測（`e2e/fullscreen-spike.test.ts`）本來就把這個後備路徑一併量過：Chromium／Firefox／WebKit 三個引擎皆可行，容器全螢幕時 iframe 靠 CSS 撐滿容器，不是新的未測假設。
>
> **沒有改變的部分**：不加 `allowfullscreen`，永遠不加 `allow-same-origin`，不授予投影片內容任何全螢幕權限——安全姿態一步都沒有放鬆，改的只是「哪個元素進全螢幕」，不是「授權模型」。iframe 仍然只被父文件以第一方身分操作，投影片內容本身完全不知道、也無法要求全螢幕。

- 不採用伺服器端消毒後直接內嵌的做法：消毒器繞過是一整族已知攻防，而瀏覽器的 sandbox 是已被打磨多年的邊界。
