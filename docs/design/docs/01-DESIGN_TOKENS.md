# 01 · Design Tokens

設計語言承襲 Holspire（暖白外殼、品牌紅、Plus Jakarta Sans）並為「深色舞台 + 玻璃浮層」的編輯器情境擴充。所有值皆以 inline style 落在原型中，此處為權威來源。

## 色彩

### 品牌 / 強調
| Token | 值 | 用途 |
|---|---|---|
| `brand.red` | `#C8233B` | 主要動作、選取框、pin 編號、播放鈕、開關 on 態 |
| `brand.red.hover` | `#A81C31` | 上述元件 hover／pressed；重點文字（Slide 3 · sub） |
| `brand.red.tint` | `#FDE8EA` | 淡紅底（Comment to AI hover、BETA、AI 頭像底、凍結提示） |
| `brand.red.tint2` | `#FBD9DD` | 淡紅底 hover |
| `brand.red.ring` | `#F5C6CC` | 淡紅描邊（active 卡片、spinner 軌） |
| `brand.red.glow` | `rgba(200,35,59,.28)` | pin 跳轉閃光 box-shadow |

### 外殼中性色（暖）
| Token | 值 | 用途 |
|---|---|---|
| `surface.0` | `#FBF9F8` | app 背景、標題列、狀態列 |
| `surface.1` | `#F5F1EF` | 縮圖軌底、segmented 底、次要 chip |
| `surface.2` | `#ECE5E2` | 分隔線、邊框、選中列底、hover |
| `surface.3` | `#F3EDEA` | 極淡分隔線 |
| `surface.white` | `#FFFFFF` | 面板、卡片、輸入框 |
| `ink.900` | `#1F1A1A` | 主要文字、黑色按鈕（Preview） |
| `ink.800` | `#2B2424` | 訊息內文 |
| `ink.700` | `#3A322F` | 工具列按鈕文字 |
| `ink.600` | `#4B4341` | 指令碼文字 |
| `ink.500` | `#6E635F` | 次要文字、欄位標籤 |
| `ink.400` | `#9A8F8C` | 提示文字、區塊標題 |
| `ink.300` | `#B4A9A6` | 更淡提示、快捷鍵字 |
| `ink.200` | `#D9CFCB` | 虛線框、關閉態開關 |

### 舞台（深）
| Token | 值 | 用途 |
|---|---|---|
| `well.bg` | `#3A3A3D` | 舞台區背景（編輯） |
| `well.play` | `#000000` | 播放模式背景 |
| `slide.bg.a` | `#14161A` | 投影片底色 A |
| `slide.bg.b` | `#1B1D24` | 投影片底色 B |
| `slide.ink` | `#F4F6F8` | 投影片標題 |
| `slide.ink.2` | `#E7E9EE` | 表格／內文 |
| `slide.muted` | `#A9B0B8` | 副標、軸標、表頭 |
| `slide.line` | `rgba(255,255,255,.1)` | 格線、表格線 |
| `guide` | `#FF5C7A` | 對齊輔助線 |

### 語意色
| Token | 值 | 用途 |
|---|---|---|
| `ok` | `#3BA55D` / text `#2E7D4F` / bg `#EAF6EE` | Done 徽章 |
| `info` | `#5B6DEA` / bg `#EEF0FD` | PDF+ 標籤、圖表第二色 |
| `accent.palette.brand` | `#C8233B #5B6DEA #4A8F45 #E08A2E #2B9E75 #A9B0B8` | 圖表預設調色盤、投影片 accent |
| `accent.palette.cool` | `#5B6DEA #2B9E75 #38BDF8 #A78BFA #22C55E #94A3B8` | |
| `accent.palette.warm` | `#C8233B #E08A2E #F4C542 #D9634C #B45309 #A9B0B8` | |

## 字體
| Token | 值 |
|---|---|
| `font.ui` | `'Plus Jakarta Sans','Noto Sans TC','PingFang TC','Microsoft JhengHei',system-ui,sans-serif` |
| `font.mono` | `ui-monospace, Menlo, monospace`（指令碼、快捷鍵、媒體標籤） |
| `font.slide` | 同 `font.ui`；投影片內字級以 `cqw`（容器寬 %）表示，隨舞台縮放 |

### 字級（UI）
| Token | px | 用途 |
|---|---|---|
| `text.2xs` | 9.5–10 | 圖表類型標、BETA |
| `text.xs` | 10.5–11 | 區塊標題（大寫 .06em）、提示、快捷鍵 |
| `text.sm` | 11.5–12 | 按鈕、chip、面板內文 |
| `text.base` | 12.5–13 | 主要 UI 文字、訊息 |
| `text.md` | 13.5–14 | 檔名、面板標題 |
| `text.lg` | 16–18 | 對話框標題、總覽標題 |

### 字級（投影片，容器單位）
| 元件 | 值 |
|---|---|
| 標題（置中版面） | `6.2cqw / 700` |
| 標題（左右版面） | `4.6cqw / 700` |
| 副標 | `2.6cqw / 400` |
| 內文 | `2.2cqw / 400`；Caption `1.6cqw` |
| 表格 | 表頭 `1.5cqw` 大寫；內容 `2cqw` |

## 間距與尺寸
| Token | 值 |
|---|---|
| `space.1..6` | 4 / 6 / 8 / 10 / 12 / 14 px |
| `space.8` | 16 px（面板 padding） |
| `space.gutter` | 28px 36px（舞台留白）+ 底部 76px（工具列保留區） |
| `titlebar.h` | 48 px |
| `toolbar.h` | 46 px（浮動玻璃） |
| `statusbar.h` | 36 px |
| `rail.w` | 212 px |
| `panel.w` | 340 px |
| `notes.h` | 112 px |
| `control.h` | 30–34 px（按鈕／輸入）；28 px 緊湊版 |
| `hit.min` | 28 px |

## 圓角
| Token | 值 | 用途 |
|---|---|---|
| `radius.xs` | 5–6 px | 標籤、pin 編號 |
| `radius.sm` | 7–8 px | 按鈕、chip |
| `radius.md` | 9–10 px | 輸入框、segmented |
| `radius.lg` | 12 px | 選單、卡片 |
| `radius.xl` | 14–16 px | 玻璃面板、對話框 |
| `radius.2xl` | 18–20 px | 大型對話框、空狀態卡 |
| `radius.pill` | 999px | 徽章、播放控制列 |
| `stage.radius` | 6 px | 投影片外框 |

## 陰影
| Token | 值 |
|---|---|
| `shadow.seg` | `0 1px 3px rgba(40,20,20,.12), 0 1px 2px rgba(40,20,20,.06)` — segmented 選中 |
| `shadow.menu` | `0 12px 32px rgba(40,20,20,.12)` |
| `shadow.dialog` | `0 24px 64px rgba(40,20,20,.25)` |
| `shadow.red` | `0 4px 12px rgba(200,35,59,.22)` — 主要 CTA、pin |
| `shadow.stage` | `0 1px 2px rgba(0,0,0,.4), 0 24px 64px -16px rgba(0,0,0,.7)` |
| `shadow.glass` | `inset 0 1px 0 rgba(255,255,255,.6), 0 12px 32px rgba(0,0,0,.28)` |

## 玻璃材質（Glass）
舞台上所有浮層（工具列、情境列、留言框、圖表資料視窗）共用：
```
background: rgba(255,255,255,.72)   /* 情境列／留言框 .55 */
backdrop-filter: blur(22px) saturate(1.5)
border: 1px solid rgba(31,26,26,.10)
box-shadow: shadow.glass
border-radius: 12–16px
```
玻璃內按鈕 hover：`rgba(31,26,26,.07)`；分隔線 `rgba(31,26,26,.1)`；輸入框 `rgba(255,255,255,.38)` → focus `.55`。

## 動效
| Token | 值 | 用途 |
|---|---|---|
| `ease.out` | `cubic-bezier(.2,.8,.2,1)` | 進場、選單長出 |
| `ease.in` | `cubic-bezier(.4,0,.8,.4)` | 頁面 exit |
| `dur.fast` | 100–150 ms | hover、選單 |
| `dur.base` | 180–260 ms | 面板切換、總覽 |
| `hs-fade` | 4px 上移 + 淡入 | 面板／卡片 |
| `hs-grow` | 8px 上移 + scale .96 → 1 | 從工具列正上方長出的選單 |
| `hs-pop` | 6px 上移（居中） | 舊情境列 |
| 物件進場 | `cm-a-fade / flyup / flyleft / zoom / wipe` | 預設 .6s |
| 頁面進場 | `cm-t-fade / slide / zoom`（a/b 兩份以便重播） | 預設 .6s |
| 頁面退場 | `cm-x-fade / slide / zoom` | 預設 .5s |
| 圖表 | `cg-grow / growx / fade / dash` 內嵌於 SVG `<style>` | 自包含 |

## 圖示
20×20 viewBox、`stroke:currentColor; fill:none; stroke-width:1.5`（小尺寸 1.6–1.8）；圓角 `rx` 1.5–2。全部定義於 `ICONS` 常數。
