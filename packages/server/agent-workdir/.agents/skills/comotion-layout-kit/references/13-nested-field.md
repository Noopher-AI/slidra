# 13 · nested-field

**解的關係**：`parent`
**單位數**：1 + 2–4
**一句話**：大場域裡包著小場域——包含關係用「在裡面」直接表達，不需要線。

**什麼時候用它**：子項確實「屬於」母項的空間或範疇（一個系統內的模組、一個組織內的部門）。
**什麼時候不要用**：子項是母項的「步驟」或「屬性」而不是「成員」——那不是包含。

## 線框

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect x="0" y="0" width="1280" height="720" fill="#FFFFFF" stroke="#CFCFCF"/>
<text x="80" y="104" font-size="40" fill="#2E2E2E" font-weight="700">標題（label）</text><rect x="80" y="126" width="64" height="5" fill="#909090"/>
<rect x="120" y="176" width="1080" height="440" fill="#F6F6F6" stroke="#BFBFBF"/><text x="152" y="222" font-size="28" fill="#2E2E2E" font-weight="700">母項</text><rect x="168" y="260" width="296" height="320" fill="#EDEDED" stroke="#BFBFBF"/><text x="196" y="306" font-size="24" fill="#555555" font-weight="700">子項1</text><text x="196" y="364" font-size="20" fill="#777777">內文一</text><text x="196" y="404" font-size="20" fill="#777777">內文二</text><text x="196" y="444" font-size="20" fill="#777777">內文三</text><rect x="536" y="260" width="296" height="320" fill="#EDEDED" stroke="#BFBFBF"/><text x="564" y="306" font-size="24" fill="#555555" font-weight="700">子項2</text><text x="564" y="364" font-size="20" fill="#777777">內文一</text><text x="564" y="404" font-size="20" fill="#777777">內文二</text><text x="564" y="444" font-size="20" fill="#777777">內文三</text><rect x="904" y="260" width="296" height="320" fill="#EDEDED" stroke="#BFBFBF"/><text x="932" y="306" font-size="24" fill="#555555" font-weight="700">子項3</text><text x="932" y="364" font-size="20" fill="#777777">內文一</text><text x="932" y="404" font-size="20" fill="#777777">內文二</text><text x="932" y="444" font-size="20" fill="#777777">內文三</text>
<line x1="80" y1="656" x2="1200" y2="656" stroke="#D0D0D0" stroke-width="1"/><text x="80" y="688" font-size="18" fill="#A0A0A0">簡報名　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　N / N</text>
</svg>
```

## 槽位

| 槽位 | 角色 | 內容 | 字數預算 | 行數 |
|---|---|---|---|---|
| 標題 | `label` | | 15 字 | 1 |
| 母場域 | `field` | 包住全部 | — | — |
| 母項名 | `label` | 放在母場域左上 | 12 字 | 1 |
| 子項 ×N | `node`（各自 `field`） | | 10 字 | 1 |
| 子項內文 | `label` | | 每條 16 字，2–3 條 | 1 |

## 節奏

母場域的內距至少一個 `layout.spacing` 的中級距——**內距太小會讓包含關係看起來像重疊**。子項等寬等高。

`blueprint.shape` 寫 `nested-field`。

## 變體

- **不等寬**：主要的子項佔 50%，其餘平分——當子項有主次時。
- **雙層**：子項裡再包孫項，但不要超過兩層。
