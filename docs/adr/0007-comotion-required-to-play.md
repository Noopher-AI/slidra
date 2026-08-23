# 播放 `.comot` 需要安裝 CoMotion

ADR-0005 曾要求動畫 runtime 不得依賴 server，理由是讓 `co-motion export --html` 幾乎免費，並讓上台簡報時不必在每台電腦安裝 CoMotion。這個要求現在撤銷。

CoMotion 是一個 server：`co-motion serve` 啟動後用瀏覽器操作，未來包成 Mac app 也只是把同一個 server 藏進去。播放與編輯是同一個 web app 的兩個模式，因此 runtime 可以、也應該取用 server。

代價不是「簡報無法分享」。分享的途徑是**匯出成別的格式**（HTML、PDF 等），那是 CoMotion server 端的功能，要做的時候再做。`.comot` 本身是工作格式，只在 CoMotion 裡跑。

## Consequences

- 動畫 runtime 可以取用 server：影音走 `/api/raw` 串流與 HTTP Range，資產不必整包塞進瀏覽器。
- 播放器不是獨立產物，而是編輯器同一個 web app 的一個模式。不維護兩套 SVG 解讀邏輯。
- `.comot` 交到沒有安裝 CoMotion 的人手上不會動。要給別人看，走匯出。
- ADR-0001 的驗收標準從品味升級為最後的相容性保證：單張 `slides/00N.svg` 用瀏覽器或向量繪圖工具開啟時，靜態畫面必須正常。那是未安裝 CoMotion 的人唯一還能看到內容的途徑，此後不得再被侵蝕。
- 只取代 ADR-0005 中「runtime 不得依賴 server」一段。ADR-0005 的其餘決定（`data-comot-*` 屬性、不用 SMIL 與 CSS animation、不用 `<foreignObject>`）不受影響。
