---
name: comotion-layout-kit
description: 從 30 種版面裡挑一種來排這一頁——每種都附線框 SVG、槽位的字數預算與角色標記，並聲明它解的是哪一種內容關係
---

# 版面庫

版面回答的是：**這一頁的內容之間是什麼關係，該用什麼幾何承載**。每一種版面都聲明它解哪一種 `relationship`，並把每個槽位該放多少字、用什麼角色標記講清楚。

**目錄是起點，不是白名單。** 可以改欄數、改比例、混兩種、或自己組——自己組的時候 `blueprint.shape` 給一個描述性的名字。

## 觸發語

作者的訊息以 `/comotion-layout-kit` 開頭，後面接**想要的排法**（選填）與頁碼：

```
/comotion-layout-kit 三個並排的重點
/comotion-layout-kit 左圖右文 3
/comotion-layout-kit                  ← 依這一頁的 relationship 自己挑
```

## 輸入格式

- 自由文字是匹配依據：欄數、圖文關係、方向感、參考對象都可以。
- 尾巴的頁碼限定要排哪一頁；沒給就是作者當前看的那一頁（問一下）。
- **這一頁的 `relationship` 優先於作者的描述**：描述說「三欄」但關係是 `order` 時，要選有方向的解，並在回報裡說明為什麼。

## 步驟

1. **讀關係**：`co-motion cat <presentation-id> plan/outline.md`，取這一頁的 `relationship`。沒有計畫時依內容自己判斷（`reference/slide-design.md` 第 6.1 節）。
2. **讀風格**：`co-motion cat <presentation-id> plan/design-spec.md`，取配色、字級表與 `layout` 錨點。**版面的座標一律由錨點推導**，不要用檔案裡的示意數字。
3. **看上一頁用了什麼**：相鄰兩頁關係相同時必須換一個版面（`validate` 的 `rhythm.repeated-shape` 會擋）。
4. **讀索引**挑一個，**只讀中選的那一個檔**：`references/<編號>-<名字>.md`。
5. **對槽位**：把內容塞進槽位表，超過字數預算就改短或減少單位，**不要縮字級**。
6. **寫頁面**：依骨架寫整頁 SVG（`slide add --svg` 或 `slide set --svg`），每個語意單位標 `data-comot-role`。
7. **寫回 blueprint**：`shape` 填這個版面的名字，`nodes`／`steps` 填實際值。
8. **檢查**：`co-motion validate <presentation-id> slides/00N.svg` 要 0 錯誤。

## 30 種版面

| 編號 | 名字 | 解的關係 | 一句話 | 單位數 |
|---|---|---|---|---|
| 01 | `card-wall` | `membership` | 等高橫條卡片垂直排列，最中性的並列 | 3–5 |
| 02 | `split-panel` | `contrast` | 左右等寬面板，共用基準線 | 2 |
| 03 | `spine-path` | `order` | 一條主軸串起節點，看得出方向與端點 | 3–5 |
| 04–30 | *（第 4 期補齊）* | | | |

## 使用的命令

`cat`、`slide add`、`slide set`、`element group`、`plan set`、`validate`。

## 回報格式

先一行：「第 N 頁：<版面名字>（解 <關係>）——<一句話>，<單位數> 個單位、<步數> 步」。接著逐槽位一行：槽位名、放了什麼、幾個字（超過預算要標出來）。最後一行列出兩個備選版面。

## 不可做的事

- 不把整個 `references/` 讀進來——只讀中選的那一個。
- **不用檔案裡的示意座標**：那些數字是用 `side_margin: 80` 的 1280×720 算的，實際座標一律從 `design-spec.layout` 推導並乘以 `k`。
- 不選跟這一頁關係不合的版面，即使作者的描述比較像它——先講清楚再讓作者決定。
- 不為了塞進版面而縮字級或刪掉意思；塞不下就減少單位或拆頁。
- 不在版面裡放背景類型的裝飾（大圓、光暈、格線）——那是背景圖的事。
