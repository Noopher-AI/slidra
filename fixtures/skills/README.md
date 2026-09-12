# 主場景 skill 驗收 fixtures

這個目錄底下三份 deck，分別驗收 `.agents/skills/comotion-{plan,reshape,validate}/SKILL.md` 三個主場景 skill。每個 deck 目錄是一份未打包的簡報（`project.json` ＋ `slides/00N.svg`，`outline-deck` 多一個 `INPUT.md`），各自搭配一份 `EXPECTED.md` 描述跑完該 skill 之後應該長成什麼樣子。

## 怎麼把 deck 打包並開啟

```bash
mkdir -p .scratch && export CO_MOTION_HOME="$PWD/.scratch/home"
node -e "import('./packages/core/dist/index.js').then(m=>m.packDirectory('fixtures/skills/check-deck','.scratch/check.comot'))"
node packages/cli/bin/co-motion.js open ./.scratch/check.comot     # 記下回傳的識別碼
node packages/cli/bin/co-motion.js ls <識別碼> slides
node packages/cli/bin/co-motion.js comment list <識別碼>
node packages/cli/bin/co-motion.js cat <識別碼> slides/001.svg
```

把 `check-deck` 換成 `outline-deck` 或 `reshape-deck` 就能打包開啟其他兩份。

## 三份 fixture 各驗哪個 skill

| 目錄 | 驗證的 skill | 說明 |
|---|---|---|
| `outline-deck/` | `/comotion-plan` 再 `/comotion-build` | `INPUT.md` 是一份 5 段大綱，`EXPECTED.md` 描述應該長成的 5 頁投影片 |
| `reshape-deck/` | `/comotion-reshape` | 3 頁、預埋 5 則留言（3 則可處理、2 則不可處理），`EXPECTED.md` 逐則列出處理結果 |
| `check-deck/` | `/comotion-validate` | 5 頁、沒有計畫檔、預埋 6 類結構問題（每類一個），`EXPECTED.md` 列出通讀步驟應釘留言的 (頁, target) 配對 |

## 驗收紀錄放哪

真實 agent（Claude Code、Codex）實際跑過某個 (agent, skill) 組合之後，把對話紀錄與結果 deck 存到 `fixtures/skills/records/<claude|codex>-<skill>/`（例如 `fixtures/skills/records/claude-outline/`）。**沒有真的跑過就不要建立這個目錄**——空的或手寫的紀錄檔等於假證據。
