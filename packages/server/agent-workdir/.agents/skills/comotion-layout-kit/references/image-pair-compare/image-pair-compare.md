# image-pair-compare

**解的關係**：`contrast`
**單位數**：2
**一句話**：兩張圖並排，中間一條分界——用圖比較，文字只標出兩邊是什麼。

**什麼時候用它**：同一個東西的兩個狀態或兩個版本，而差異用看的最快。
**什麼時候不要用**：兩張圖的拍攝角度或尺度不同——比較會失真，先裁成一致再用。

## 線框

完整 SVG：見同資料夾 `image-pair-compare.svg`。

## 槽位

| 槽位 | 角色 | 內容 | 字數預算 | 行數 |
|---|---|---|---|---|
| 標題 | `label` | | 15 字 | 1 |
| 圖 ×2 | `node`（`image`） | **同尺寸同比例** | — | — |
| 標籤 ×2 | `label` | 「之前／之後」或版本名 | 6 字 | 1 |
| 差異說明 | `label` | 一句話點出要看哪裡 | 22 字 | 1 |

## 節奏

兩圖等寬等高、頂端對齊。**差異說明必須指出「看哪裡」**——沒有它，聽眾會自己找，而且常常找錯地方。

`blueprint.shape` 寫 `image-pair-compare`。

## 怎麼放進去

```
co-motion element insert image <id> slides/00N.svg --x 80 --y 176 --width 540 --height 340 --media assets/<前.jpg>
co-motion element insert image <id> slides/00N.svg --x 660 --y 176 --width 540 --height 340 --media assets/<後.jpg>
```

## 變體

- **上下版**：改成上下排列，時間感更強（同 17 `before-after` 的邏輯）。
- **局部放大**：其中一張加一個放大的局部方框，指出關鍵差異。
