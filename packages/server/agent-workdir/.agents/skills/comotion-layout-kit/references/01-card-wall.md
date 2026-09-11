# 01 · card-wall

**解的關係**：`membership`（並列、歸屬、同一組裡的幾件事）
**單位數**：3–5
**一句話**：等高的橫條卡片垂直排列，間距一致——最中性的並列，沒有方向、沒有主從。

**什麼時候用它**：幾件事地位相等、順序可以互換。三條產品特色、四個組成要素。
**什麼時候不要用**：只要內容其實有先後（`order`）、有對比（`contrast`）、或有層級（`parent`），卡片牆就會把那層意思抹平。**相鄰兩頁都用它是最常見的錯誤**。

## 線框

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect x="0" y="0" width="1280" height="720" fill="#FFFFFF" stroke="#CCCCCC"/>
<text x="80" y="90" font-size="28" fill="#333333">標題（label）</text>
<rect x="80" y="120" width="56" height="4" fill="#999999"/>
<rect x="80" y="176" width="1120" height="72" fill="#EEEEEE" stroke="#AAAAAA"/>
<text x="104" y="200" font-size="18" fill="#666666">01</text>
<text x="200" y="200" font-size="18" fill="#666666">node 1：field + 編號 label + 關鍵詞 label</text>
<rect x="80" y="264" width="1120" height="72" fill="#EEEEEE" stroke="#AAAAAA"/>
<text x="104" y="288" font-size="18" fill="#666666">02</text>
<text x="200" y="288" font-size="18" fill="#666666">node 2</text>
<rect x="80" y="352" width="1120" height="72" fill="#EEEEEE" stroke="#AAAAAA"/>
<text x="104" y="376" font-size="18" fill="#666666">03</text>
<text x="200" y="376" font-size="18" fill="#666666">node 3</text>
<line x1="80" y1="656" x2="1200" y2="656" stroke="#CCCCCC"/>
<text x="80" y="676" font-size="14" fill="#999999">頁尾三件</text>
</svg>
```

## 槽位

| 槽位 | 角色 | 內容 | 字數預算 | 行數 |
|---|---|---|---|---|
| 標題 | `label` | 這一頁的主張 | 15 字（上限 24） | 1 |
| 標題底線 | `garnish` | accent 短棒 | — | — |
| 卡片 ×N | `node`（內含 `field`） | 每張一個語意單位 | — | — |
| 編號 | `label` | `01`／`02`… | 2 字 | 1 |
| 關鍵詞 | `label` | 這個單位在說什麼 | 18 字（上限 32） | 1 |
| 頁尾三件 | — | 線、簡報名、頁碼 | — | — |

## 節奏

卡片等高、間距一致——**均勻是重點**，因為並列的內容沒有輕重之分。卡片高度與間距由 `layout.spacing` 推導；N 張卡片的總高不得越過 `bottom_margin`。

`blueprint.shape` 寫 `card-wall`；`type` 可一併填 `bullets`。

**動畫**：標題一步，之後每張卡片一步（1＋N）。卡片與它的編號、關鍵詞先 `element group` 成一組，效果下在群組上。

## 變體

- **窄卡片**：卡片只佔左 2/3，右側留白給一張圖或大留白。
- **無 field**：拿掉卡片底色，只留編號與關鍵詞，靠間距與細分隔線分組——更安靜，適合 `clean-brief` 這種克制的風格。
