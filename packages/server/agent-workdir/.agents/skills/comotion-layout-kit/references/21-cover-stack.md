# 21 · cover-stack

**解的關係**：`none`
**單位數**：1
**一句話**：標題、副標、日期講者由上而下貼左緣堆疊——封面的標準解。

**什麼時候用它**：封面。
**什麼時候不要用**：內容頁。

## 線框

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect x="0" y="0" width="1280" height="720" fill="#FFFFFF" stroke="#CFCFCF"/>
<rect x="140" y="230" width="72" height="6" fill="#909090"/><text x="140" y="320" font-size="72" fill="#2E2E2E" font-weight="700">大標第一行</text><text x="140" y="404" font-size="72" fill="#2E2E2E" font-weight="700">大標第二行</text><text x="140" y="500" font-size="28" fill="#555555">副標（label）</text><text x="140" y="610" font-size="18" fill="#A0A0A0">日期・講者</text>
</svg>
```

## 槽位

| 槽位 | 角色 | 內容 | 字數預算 | 行數 |
|---|---|---|---|---|
| 短棒 | `garnish` | accent 色 | — | — |
| 大標 | `label`（`cover` 字級） | 大綱裡最強的一句 | 每行 15 字，≤ 2 行 | 1–2 |
| 副標 | `label`（`subtitle`） | | 24 字 | 1 |
| 日期講者 | `label`（`caption`） | | 20 字 | 1 |

## 節奏

四件貼同一條左緣，垂直間距用 `layout.spacing` 的大級距。**不放頁尾**。大標與副標之間的距離要明顯大於副標與日期之間的——那是分組。

`blueprint.shape` 寫 `cover-stack`。

## 變體

- **置中版**：全部水平置中，適合 `luxury-noir`、`bold-poster` 這種海報感的風格。
- **右下角資訊**：日期講者移到右下，與大標形成對角平衡。
