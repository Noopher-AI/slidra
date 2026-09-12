# 字型庫

風格的性格有一半來自字型。這份清單是**策展過的開源字型**：授權都允許嵌入與商用（SIL OFL 1.1 或 Apache 2.0），中文的覆蓋率都足以做一份完整的繁體簡報。

**字型檔不在 repo 裡**，用 `slidra font import` 從下面的網址匯入；匯入後那份 `.slidra` 就自帶這個字型，換一台機器打開仍然正確。

## 匯入怎麼下

```
slidra font import <presentation-id> <URL> --family '<家族名>' --license '<授權>' --source '<出處>'
```

`--family` 要**逐字**用下表的家族名——那是之後寫進 SVG `font-family` 的字串，打錯會在排版時直接失敗。

## 中文（繁體）

| 家族名 | 氣質 | 適合的風格 | 授權 | 來源 |
|---|---|---|---|---|
| `Noto Sans TC` | 中性、現代、資訊密度高。**已內建**，不用匯入 | 幾乎所有 | SIL OFL 1.1 | https://fonts.google.com/noto/specimen/Noto+Sans+TC |
| `Noto Serif TC` | 正式、有重量、筆畫有起收 | 報告、文化、需要可信度 | SIL OFL 1.1 | https://fonts.google.com/noto/specimen/Noto+Serif+TC |
| `Source Han Serif TC` | 書卷氣更濃的宋體，字面較大 | 敘事、出版、長標題 | SIL OFL 1.1 | https://github.com/adobe-fonts/source-han-serif |
| `jf open 粉圓` | 圓潤、親和、沒有攻擊性 | 教學、兒少、社群、輕鬆主題 | SIL OFL 1.1 | https://justfont.com/jfopenhuninn |
| `cwTeXKai` | 楷書，手寫的筆順感 | 人文、書法、傳統主題 | SIL OFL 1.1 | https://github.com/l10n-tw/cwtex-q-fonts |

**中文字型很大**（5～15 MB）。一份簡報最多匯入 **2 種中文字型**（標題一種、內文一種），再多會讓 `.slidra` 檔變得難以傳遞。

## 拉丁（給英文標題與數字）

| 家族名 | 氣質 | 適合的風格 | 授權 | 來源 |
|---|---|---|---|---|
| `Inter` | 中性、螢幕最佳化、數字清楚 | 產品、資料、儀表板 | SIL OFL 1.1 | https://fonts.google.com/specimen/Inter |
| `Space Grotesk` | 幾何、略帶科技感的怪異 | 科技、新創、發表會 | SIL OFL 1.1 | https://fonts.google.com/specimen/Space+Grotesk |
| `Playfair Display` | 高對比襯線，精緻、有戲劇性 | 品牌、時尚、封面大標 | SIL OFL 1.1 | https://fonts.google.com/specimen/Playfair+Display |
| `IBM Plex Mono` | 等寬，工程感、資料感 | 技術分享、程式碼、編號 | SIL OFL 1.1 | https://fonts.google.com/specimen/IBM+Plex+Mono |

拉丁字型只有 100～300 KB，多匯入一兩種沒有負擔。**但拉丁字型不含中文字**——用它排到中文會失敗，所以它只能用在確定是英文或數字的元素（大數字、英文標題、編號）。

## 規則

- **中文內容的文字框一律用中文家族**。拉丁家族只給確定不含中文的元素。
- 一份簡報的家族數控制在 **2～3 種**（中文 1～2 ＋ 拉丁 0～1）。更多的差異用字重與字級做，不要靠換字體。
- 匯入失敗（下載不到、解析不了）時**退回 `Noto Sans TC`**，並在回報裡說明——不要讓整份簡報卡在一個字型上。
- `--license` 與 `--source` 必填不是形式：嵌入他人字型的簡報要帶著它的條款。
