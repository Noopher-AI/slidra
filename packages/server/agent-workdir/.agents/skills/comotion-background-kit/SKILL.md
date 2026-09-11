---
name: comotion-background-kit
description: 從 30 種背景配方裡挑一種建成 SVG 資產並套到頁面——每種都附完整 SVG、適合的節奏與搭配的風格；用一句話描述想要的氣氛就會模糊匹配
---

# 背景庫

背景負責**氣氛**，不負責意義：拿掉它，頁面要一個字都不少。這個 skill 的工作是把作者的一句話（「乾淨一點」「有科技感」「像紙」）對應到目錄裡的一種配方，用 `asset import --svg` 建成資產，再 `slide background set` 套到頁面上。

**目錄是起點，不是白名單。** 可以改配方的參數、混兩種、或自己畫一個——只要遵守下面三條底線。

## 觸發語

作者的訊息以 `/comotion-background-kit` 開頭，後面接**想要的氣氛**（選填），可再接要套哪幾頁：

```
/comotion-background-kit 乾淨、幾乎看不出來
/comotion-background-kit 有科技感一點 2-4
/comotion-background-kit --none           ← 拿掉整份的背景圖
```

## 輸入格式

- 自由文字是匹配依據：氣氛、材質、明暗、參考對象都可以。
- 尾巴的頁碼（`3`、`2-4`）限定套用範圍；沒給就是整份。
- `--none` 是移除：對指定範圍下 `slide background set --none`。

## 步驟

1. **讀風格**：`co-motion cat <presentation-id> plan/design-spec.md`。配方裡的 `<role>` 全部換成這份簡報的色碼——背景必須跟風格同一組顏色，否則會像貼上去的。
2. **讀索引**挑配方；作者沒給描述時，依風格檔的「建議背景」與每頁的 `rhythm` 決定。
3. **讀中選的那一個檔**：`references/<編號>-<名字>.md`。**一次只讀一個。**
4. **確認畫布**：不是 1280×720 時所有座標乘以 `k = width ÷ 1280`，`viewBox` 寫成實際畫布尺寸。
5. **建資產**：`co-motion asset import <presentation-id> --svg '<配方 SVG>' --name bg-<名字>-<配色代號>.svg`。**同一種配方整份只建一次**，記下回傳的 `data.path` 重複使用。
6. **套用**：逐頁 `co-motion slide background set <presentation-id> slides/00N.svg --asset <path> --opacity <建議值>`。opacity 依頁面的 `rhythm` 調（見各配方檔）。
7. **檢查**：`co-motion validate <presentation-id>`。背景圖會讓 `structure.scrim` 開始要求文字有底——有錯就照指南第 4b 節補 scrim，不要調降 opacity 了事。

## 30 種配方

| 編號 | 名字 | 氣氛 | 適合的 `rhythm`／關係 | 建議風格 |
|---|---|---|---|---|
| 01 | `soft-blobs` | 柔焦色團，像光透過紙 | `anchor` | 02 |
| 02 | `dot-grid` | 細點陣，像方格筆記本 | `dense` | 01、03 |
| 03 | `diagonal-beams` | 斜向光束，有方向與速度 | `anchor`、`breathing`、`order` | 01 |
| 04 | `gradient-wash` | 單向漸層，最安靜的一種 | 全部 | 全部 |
| 05 | `corner-arc` | 右下一道大圓弧，像被放大的印記 | `anchor`、`breathing` | 01、06、13、20、23 |
| 06 | `paper-fiber` | 極細斜向短線，紙的纖維 | 全部 | 02、05、14、16、24 |
| 07 | `edge-frame` | 距邊的細框，像畫框或證書 | `anchor` | 14、18、20、21、24 |
| 08 | `halftone-fade` | 逐漸變稀的網點，印刷的半色調 | `anchor`、`dense` | 09、22、24 |
| 09 | `topo-lines` | 層疊的等高線，地形圖 | `anchor`、`breathing` | 10、12、23、24 |
| 10 | `side-band` | 側緣一條滿高色帶，切出主次 | `anchor`、`dense` | 01、13、18、21 |
| 11 | `grid-blueprint` | 方格網加粗主格線，製圖紙 | `dense` | 13、04、25 |
| 12 | `arc-rings` | 右上同心細環，雷達的擴散 | `anchor`、`breathing` | 01、04、10、15、23 |
| 13 | `noise-speckle` | 極細隨機斑點，底片顆粒 | 全部 | 02、05、09、22、24 |
| 14 | `split-diagonal` | 對角線切成深淺兩半 | `anchor`、`contrast` | 07、09、11、15、22 |
| 15 | `soft-vignette` | 四周略暗，注意力被帶到中間 | `breathing` | 07、15、19、20 |
| 16 | `stacked-strata` | 由下往上變淡的橫帶，地層剖面 | `anchor`、`breathing` | 10、12、18、24 |
| 17 | `ray-burst` | 右下射出的放射線，陽光 | `anchor`、`breathing` | 07、11、15、19 |
| 18 | `frosted-panel` | 右半霧面玻璃，自帶 scrim | `anchor`、`dense` | 01、15、20、23 |
| 19 | `dashed-path` | 虛線路徑，有起點與終點 | `order` | 05、10、12、23 |
| 20 | `column-rules` | 等距垂直細線，報紙的欄線 | `dense` | 09、14、21、22 |
| 21 | `corner-brackets` | 四角的直角括號，取景框 | 全部 | 04、07、13、22、25 |
| 22 | `wave-band` | 下緣起伏的波形帶，水面 | `anchor`、`breathing` | 10、12、23、08 |
| 23 | `concentric-square` | 同心方框，靶心 | `breathing` | 07、14、18、20 |
| 24 | `isometric-grid` | 30 度等角格線，立體圖紙 | `dense` | 13、04、25 |
| 25 | `spotlight-top` | 頂端打下的光束，舞台感 | `anchor`、`breathing` | 07、15、19、20 |
| 26 | `margin-notes` | 左緣窄欄，書頁的注記欄 | `dense` | 14、09、21、24 |
| 27 | `scatter-dots` | 右半散布的圓點，粒子 | `anchor`、`breathing` | 01、04、15、23 |
| 28 | `step-blocks` | 右下階梯方塊，成長與進度 | `order`、`breathing` | 11、12、18、25 |
| 29 | `cross-ticks` | 均勻的小十字，定位標記 | 全部 | 04、06、13、25 |
| 30 | `duotone-split` | 左右二分加漸層接縫，天生為對照 | `contrast` | 09、11、14、17 |

挑的時候先看**適合的節奏**那一欄：`anchor` 的頁面字少留白多，經得起有個性的背景；`dense` 的頁面已經有卡片與面板，背景只能是質地。標「全部」的四個（04、06、13、21、29）最不會出錯。

標了**關係**的三個是特例：`19 dashed-path` 與 `28 step-blocks` 有方向，只給 `order`；`30 duotone-split` 天生二分，只給 `contrast`。把它們用在並列的內容上，背景會說錯話。

## 使用的命令

`cat`、`asset import`、`slide background set`、`validate`。

## 回報格式

先一行：「背景：<名字>——<一句氣氛>，套用第 N～M 頁」。接著一行寫資產路徑與各頁的 opacity。最後一行列出兩個備選。移除時只回一行說明拿掉了哪幾頁。

## 不可做的事

- **背景不承載意義**：不畫插圖、不放圖示、不讓背景說話。拿掉它頁面要一樣完整。
- **不用 `<filter>`**：模糊靠漸層做。濾鏡會讓縮圖與匯出不一致，也拖慢渲染。
- **左半與中央（x 80～760、y 72～648）保持暗與安靜**：亮部只在右緣與右下。這是文字區能讀得清楚的前提。
- 不把整個 `references/` 讀進來——只讀中選的那一個。
- 同一種配方不重複建資產；一份簡報最多兩種配方（定錨頁一種、內容頁一種）。
- 不對背景圖加任何動畫效果。
