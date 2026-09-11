# 33 · image-pair-compare

**解的關係**：`contrast`
**單位數**：2
**一句話**：兩張圖並排，中間一條分界——用圖比較，文字只標出兩邊是什麼。

**什麼時候用它**：同一個東西的兩個狀態或兩個版本，而差異用看的最快。
**什麼時候不要用**：兩張圖的拍攝角度或尺度不同——比較會失真，先裁成一致再用。

## 線框

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect x="0" y="0" width="1280" height="720" fill="#FFFFFF" stroke="#CCCCCC"/>
<text x="80" y="90" font-size="28" fill="#333333">標題（label）</text>
<rect x="80" y="120" width="56" height="4" fill="#999999"/>
<rect x="80" y="176" width="540" height="340" fill="#E8E8E8" stroke="#AAAAAA"/>
<text x="300" y="350" font-size="16" fill="#888888">圖 A</text>
<line x1="640" y1="176" x2="640" y2="516" stroke="#666666" stroke-width="3"/>
<rect x="660" y="176" width="540" height="340" fill="#DCDCDC" stroke="#888888"/>
<text x="880" y="350" font-size="16" fill="#777777">圖 B</text>
<text x="80" y="556" font-size="20" fill="#444444">之前</text>
<text x="660" y="556" font-size="20" fill="#333333">之後</text>
<text x="80" y="596" font-size="15" fill="#888888">一句差異說明</text>
<line x1="80" y1="656" x2="1200" y2="656" stroke="#CCCCCC"/>
<text x="80" y="676" font-size="14" fill="#999999">頁尾三件</text>
</svg>
```

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
