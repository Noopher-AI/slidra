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

| 編號 | 名字 | 氣氛 | 適合的 `rhythm` | 建議風格 |
|---|---|---|---|---|
| 01 | `soft-blobs` | 柔焦色團，像光暈透過紙 | `anchor` | 02 |
| 02 | `dot-grid` | 細點陣，像方格筆記本 | `dense` | 01、03 |
| 03 | `diagonal-beams` | 斜向光束，有方向與速度 | `anchor`、`breathing` | 01 |
| 04–30 | *（第 3 期補齊）* | | | |

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
