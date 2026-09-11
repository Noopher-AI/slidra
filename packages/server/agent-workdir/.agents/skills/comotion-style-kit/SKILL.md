---
name: comotion-style-kit
description: 從 25 種風格裡挑一種寫進 plan/design-spec.md——配色、字級表、字型與間距節奏；用一句話描述想要的感覺就會模糊匹配
---

# 風格庫

風格決定這份簡報**看起來是誰在說話**：配色、字級對比、字型、間距的鬆緊。這個 skill 的工作是把作者的一句話（「專業一點」「像科技新創」「溫暖手作感」）對應到目錄裡的一種風格，讀出它的完整規格，寫進 `plan/design-spec.md`。

**目錄是起點，不是白名單。** 沒有一種剛好時，挑最近的一種改，或自己配一組——只要仍然填滿 `design-spec` 的所有欄位。自己配的時候在 `design-spec.md` 的正文寫一句它的名字與為什麼。

## 觸發語

作者的訊息以 `/comotion-style-kit` 開頭，後面接**想要的感覺**（選填）：

```
/comotion-style-kit 溫暖、手作、適合講食物的故事
/comotion-style-kit 像顧問公司的簡報，克制、可信
/comotion-style-kit                    ← 沒給描述時，依主題與 plan/outline.md 的內容自己判斷
```

## 輸入格式

- `/comotion-style-kit` 後面的自由文字就是匹配依據。可以描述氣質、場合、產業、顏色傾向、參考對象。
- 沒有文字時，讀 `plan/outline.md` 的主題與 `mode` 自己判斷。
- 已經有 `plan/design-spec.md` 時，**先問作者是要換掉還是微調**，不要直接覆蓋。

## 步驟

1. **讀索引**（下面那張表），用作者的描述做模糊匹配，挑出 1 個最合的、外加 2 個備選。
2. **讀中選的那一個檔**：`references/<編號>-<名字>.md`。**一次只讀一個**，不要把整個 references/ 讀進來。
3. **確認畫布**：`co-motion cat <presentation-id> project.json`。不是 1280×720 時，字級與 `layout` 錨點全部乘以 `k = width ÷ 1280`。
4. **字型**：風格的 `typography` 指定 heading／body 兩個家族。不在簡報裡（`co-motion cat <presentation-id> project.json` 的 `fonts`）時，照 `reference/fonts.md` 的清單用 `co-motion font import` 匯入——**`--family` 要逐字照抄清單上的家族名**，`--license` 與 `--source` 也照抄。匯不到（下載失敗、解析失敗）就退回內建的 `Noto Sans TC`，並在回報裡說明少了什麼。中文家族最多匯入 2 種。
5. **寫入**：`co-motion plan set <presentation-id> design-spec '<全文>'`。正文寫一句為什麼選這個風格。
6. **回報**：照下面的格式，附上另外兩個備選，讓作者知道還有什麼可以換。

## 25 種風格

| 編號 | 名字 | 第一秒的感覺 | 適合 | 建議背景 |
|---|---|---|---|---|
| 01 | `editorial-tech` | 深色、精準、克制，像技術部落格的深色模式 | 產品說明、技術分享、開發者活動 | 02、03 |
| 02 | `warm-editorial` | 奶油底配酒紅，紙感、溫度、有人味 | 飲食、文化、品牌故事、教學 | 01 |
| 03 | `clean-brief` | 白底藍字，安靜、可信、不搶戲 | 顧問簡報、內部報告、提案 | 02 |
| 04–25 | *（第 2 期補齊）* | | | |

## 使用的命令

`cat`、`plan set`、`font import`。字型清單見 `reference/fonts.md`。

## 回報格式

先一行：「風格：<名字>——<一句感覺>」。接著三行：配色（六個角色的色碼）、字級（`cover`／`title`／`body` 三個代表值）、字型（heading／body 家族）。最後一行列出兩個備選與它們的差別，並說明想換的話講一聲就好。

## 不可做的事

- 不把整個 `references/` 讀進來——只讀中選的那一個。
- 不在沒問過作者的情況下覆蓋既有的 `design-spec.md`。
- 不混搭兩種風格的配色：配色是一組，拆開用會失去它的邏輯。字級與間距可以微調。
- 不使用簡報沒有內嵌的字型家族（寫入會直接失敗）。
- 不自己發明配色角色或字級角色的名字——欄位是固定的七個與九個。
