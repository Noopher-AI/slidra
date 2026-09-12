---
name: slidra-background-kit
description: 從 47 種背景配方裡挑一種建成 SVG 資產並套到頁面，每種都附完整 SVG、適合的節奏與搭配的風格，用一句話描述想要的氣氛就模糊匹配；也負責移除背景。作者的訊息以 /slidra-background-kit 開頭、或 slidra-plan／slidra-build 要挑背景配方時用
---

# 背景庫

背景負責**氣氛**，不負責意義：拿掉它，頁面要一個字都不少。這個 skill 把作者的一句話（「乾淨一點」「有科技感」「像紙」）對應到目錄裡的一種配方，用 `asset import --svg` 建成資產，再 `slide background set` 套到頁面上。

**目錄是起點，不是白名單。** 可以改配方的參數、混兩種、或自己畫一個，只要守住三條底線：不用 `<filter>`（模糊靠漸層做，濾鏡會讓縮圖與匯出不一致）；左半與中央（x 80～760、y 72～648）保持安靜，有個性的部分只放右緣與右下（深底配方靠壓暗達成，淺底配方靠不畫東西達成）；大面積柔和色塊只用 `primary` 與 `accent`（需要第三層次時用 `secondary_bg`），`secondary_accent` 只給線條與小面積——它在許多配色裡是另一個色系，大面積混進底色會變成一塊濁色。

配方檔裡的顏色寫成 `fill="var(--primary, #4F8DFF)"` 這種 CSS 變數語法，逗號後面是預覽用的預設值。建資產時把整段 `var(--role, #預設色)` 換成這份簡報的實際色碼。

## 輸入

```
/slidra-background-kit 乾淨、幾乎看不出來
/slidra-background-kit 有科技感一點 2-4
/slidra-background-kit --none           ← 拿掉整份的背景圖
```

- 自由文字是匹配依據：氣氛、材質、明暗、參考對象。
- 尾巴的頁碼（`3`、`2-4`）限定套用範圍；沒給就是整份。
- `--none` 是移除：對指定範圍下 `slide background set --none`。

## 步驟

1. **讀風格**：`slidra cat <presentation-id> plan/design-spec.md`。背景必須跟風格同一組顏色。看 `background` 色碼分明暗：25 種風格裡有 17 種是淺底。
2. **讀索引**挑配方；作者沒給描述時，依風格檔的「建議背景」與每頁的 `rhythm` 決定。`anchor` 的頁面字少留白多，經得起有個性的背景；`dense` 的頁面已經有卡片與面板，背景只能是質地。有方向的配方（`19 dashed-path`、`38 perspective-floor`）只給 `order` 關係的頁面。
3. **讀中選的那一個檔**：`references/<名字>/<名字>.md`。一次只讀一個。
4. **確認畫布**：不是 1280×720 時所有座標乘以 `k = width ÷ 1280`，`viewBox` 寫成實際畫布尺寸。
5. **挑色系**：每個配方檔列出 `base` 之外的兩種角色對應。色系是角色對應表而不是色碼——同一張圖換一組角色去填，顏色仍然全部來自這份簡報的配色。內容頁用 `base`，定錨頁想跟內容頁區隔時用另一種；一份簡報最多兩種配方、最多兩種色系。
6. **建資產**：把 `var(--role, …)` 換成對應後的角色色碼，`slidra asset import <presentation-id> --svg '<配方 SVG>' --name bg-<名字>-<配色代號>[-<色系>].svg`。同一種配方＋同一種色系整份只建一次，記下回傳的 `data.path`。
7. **套用**：逐頁 `slidra slide background set <presentation-id> slides/00N.svg --asset <path> --opacity <建議值>`。opacity 依頁面的 `rhythm` 調（各配方檔有建議值）。背景圖從第一格就在，不加動畫。
8. **檢查**：`slidra validate <presentation-id>`。背景圖會讓 `structure.scrim` 開始要求文字有底——有錯就照 `reference/slide-design.md` 第 4b 節補 scrim；調降 opacity 不是修法。

## 47 種配方

| 編號 | 名字 | 氣氛 | 適合 | 建議風格 |
|---|---|---|---|---|
| 01 | `soft-blobs` | 三團重疊的光暈從右側漫進來，邊界完全化開。 | `anchor`（封面、章節、結語） | 02 `warm-editorial`（最搭）。01 `editorial-tech` 的深底會把色團吃掉，要用的話 opacity 拉到 1.0 並把漸層的 stop-opacity 調高。 |
| 02 | `dot-grid` | 均勻的細點陣鋪滿整頁，像方格筆記本或工程圖紙。 | `dense`（內容頁） | 01 `editorial-tech`、03 `clean-brief`（opacity 要壓低）。02 `warm-editorial` 的紙感跟格線衝突，不建議。 |
| 03 | `diagonal-beams` | 三道從右上斜向左下的光束，左側被徑向漸層壓暗。 | `anchor`、`breathing`，以及 `order` 關係的頁面（光束的方向會強化閱讀方向） | 01 `editorial-tech`。淺底風格上光束會太顯眼，要用的話 opacity 降到 0.3 以下。 |
| 04 | `gradient-wash` | 從左下到右上的單向漸層，沒有任何圖形。 | 任何節奏 | 全部。特別適合 03、06、17、21、25 這些克制的風格。 |
| 05 | `corner-arc` | 右下角一道大圓弧切進畫面，像一枚被放大的印記。 | `anchor`、`breathing` | 01、06、13、20、23。 |
| 06 | `paper-fiber` | 極細的斜向短線隨機分布，像紙的纖維。 | 任何節奏，尤其是紙感風格的全部頁面 | 02、05、14、16、24。 |
| 07 | `edge-frame` | 距離邊界一段距離的細框，像展場的畫框或證書的邊。 | `anchor` | 14、18、20、21、24。 |
| 08 | `halftone-fade` | 從右下往左上逐漸變稀的網點，像印刷的半色調。 | `anchor`、`dense` 皆可 | 09、22、24。 |
| 09 | `topo-lines` | 層層疊起的等高線，像地形圖。 | `anchor`、`breathing` | 10、12、23、24。 |
| 11 | `grid-blueprint` | 完整的方格網加上較粗的主格線，像製圖紙。 | `dense` | 13、04、25。 |
| 12 | `arc-rings` | 右上角一組同心細環，像雷達或聲波的擴散。 | `anchor`、`breathing` | 01、04、10、15、23。 |
| 13 | `noise-speckle` | 極細的隨機斑點，像底片顆粒或影印的雜訊。 | 任何節奏 | 02、05、09、22、24。 |
| 14 | `split-diagonal` | 一條對角線把畫面分成深淺兩半。 | `anchor`、以及 `contrast` 關係的頁面 | 07、09、11、15、22。 |
| 15 | `soft-vignette` | 四周略暗、中央略亮，像打了一盞柔光。 | `breathing`（大數字、一句主張） | 07、15、19、20。 |
| 16 | `stacked-strata` | 水平的色帶由下往上逐層變淡，像地層剖面。 | `anchor`、`breathing` | 10、12、18、24。 |
| 18 | `frosted-panel` | 右半一塊半透明的霧面板，像玻璃壓在畫面上。 | `anchor`、`dense` | 01、15、20、23。 |
| 19 | `dashed-path` | 一條虛線從左下彎到右上，像地圖上的路徑或流程的軌跡。 | `order` 關係的頁面（它會強化 `spine-path` 的方向） | 05、10、12、23。 |
| 21 | `corner-brackets` | 四個角落各一組直角括號，像取景框或掃描的定位標記。 | 任何節奏 | 04、07、13、22、25。 |
| 22 | `wave-band` | 畫面下緣一道起伏的波形帶，像水面或聲波。 | `anchor`、`breathing` | 10、12、23、08。 |
| 24 | `isometric-grid` | 30 度的等角格線，像工程的立體圖紙。 | `dense`，特別是講架構或系統的頁面 | 13、04、25。 |
| 25 | `spotlight-top` | 從頂端中央打下來的一束光，往下逐漸散開。 | `anchor`（封面）、`breathing` | 07、15、19、20。 |
| 27 | `scatter-dots` | 大小不一的圓點隨機散布在右半，像粒子或星點。 | `anchor`、`breathing` | 01、04、15、23。 |
| 29 | `cross-ticks` | 均勻分布的小十字標記，像設計稿的定位點或星圖。 | 任何節奏 | 04、06、13、25。 |
| 31 | `mesh-gradient` | 四團顏色在畫面上互相滲透，邊界完全化開，像未乾的顏料。 | 任何節奏 | 全部，特別是 01、10、15、23。 |
| 32 | `blob-corners` | 左上與右下各一團有機形狀，中間留出一條乾淨的斜向通道。 | `anchor`、`breathing` | 02、08、11、16、23。 |
| 33 | `layered-waves` | 三層波浪由上而下填滿，顏色愈往下愈實。 | `anchor`、`breathing`；內容集中在上半時也可用於 `dense` | 10、12、22、23。 |
| 34 | `stacked-peaks` | 三層山稜線由高到低疊起。 | `anchor`、`breathing` | 10、12、24。 |
| 35 | `low-poly` | 整面被切成不規則的三角形，像揉皺又攤平的紙。 | 任何節奏 | 01、04、13、15。 |
| 36 | `polygon-scatter` | 七個大小不一的多邊形散在右半，只有描邊沒有實心。 | `anchor`、`breathing` | 01、04、13、25。 |
| 37 | `bokeh-orbs` | 大小不一的光圈散布在右半，像失焦的夜景。 | `anchor`、`breathing` | 01、15、20、23。 |
| 38 | `perspective-floor` | 地平線上的透視格線，往右方的消失點收斂。 | `anchor`、`breathing`，以及 `order` 關係的頁面 | 01、04、13、15。 |
| 39 | `hex-mesh` | 六角網格鋪滿整面，像蜂巢或分子結構。 | `dense` | 01、04、13、25。 |
| 40 | `chevron-stack` | 下半部一疊之字形，愈往下愈實。 | `anchor`、`breathing` | 07、11、15、22。 |
| 41 | `ten-print` | 由隨機斜線組成的迷宮紋理（10 PRINT 的那個圖案）。 | `dense`、`anchor` | 01、04、13、22、25。 |
| 42 | `scales` | 半圓層層交疊成魚鱗。 | `dense`、`anchor` | 02、05、12、24。 |
| 43 | `ripple` | 從右下角擴散出去的同心圓。 | `anchor`、`breathing` | 01、10、15、23。 |
| 44 | `oscillate` | 十條起伏的曲線平行排列，相位交錯。 | `dense`、`anchor` | 08、10、19、22。 |
| 45 | `grain-gradient` | 右上一團光，整面覆蓋細顆粒。 | 任何節奏 | 02、05、09、22、24。 |
| 46 | `sunlit-wash` | 晨光從右上角斜灑進來，亮到近乎過曝，左半整片留白。 | `anchor`、`breathing` | ☀ 02、08、11、16、19、23。 |
| 47 | `pastel-fields` | 幾塊帶斜切邊的淡色域在右側相鄰，像疊起來的色紙。 | `anchor`、`breathing`、`contrast` | ☀ 02、05、08、11、16、22。 |
| 48 | `airy-lines` | 極細的水平線由密到疏往下排開，像信紙。 | `dense`、`order` | ☀ 03、06、09、14、17、21、25。 |
| 49 | `confetti-light` | 一叢小色片落在右上角，明亮、輕快、有動勢。 | `anchor`、`breathing` | ☀ 08、11、19、22、23、25。 |
| 50 | `soft-arches` | 三道大拱門由後往前疊在右側。 | `anchor`、`breathing`、`parent` | ☀ 02、05、08、11、16、23、24。 |
| 51 | `linen` | 極細的交織紋鋪滿整面，像亞麻布。 | 任何節奏 | ☀ 02、05、09、14、16、21、24。 |
| 52 | `edge-glow` | 右緣與上緣各一道窄而亮的光帶，中央完全乾淨。 | 任何節奏 | ☀ 全部淺色風格。 |
| 53 | `dotted-arc` | 三圈由點組成的弧線從右下升起。 | `anchor`、`breathing`、`order` | ☀ 04、10、12、19、22、23。 |
| 54 | `washi` | 大塊極淡的色斑加上均勻的纖維點，像手抄和紙。 | 任何節奏 | ☀ 02、05、09、14、16、24。 |

**先分明暗。** 標 ☀ 的九個（46–54）是為**淺底配色**畫的，深色配色用它們會太弱；其餘的是深底優先，在淺底上要壓低透明度。淺底與深底的濃度不能共用一組數字：淺底上的線要 1.4px／0.2 以上、點要 3px 以上才看得見，大面積低透明度的柔和色塊會糊成一塊灰褐——深底剛好相反。

## 回報格式

先一行：「背景：<名字>——<一句氣氛>，套用第 N～M 頁」。接著一行寫資產路徑與各頁的 opacity。最後一行列出兩個備選。移除時只回一行說明拿掉了哪幾頁。
