# Slidra

## Agent skills

### Issue tracker

Issues 與 PRD 以 GitHub Issues 追蹤，透過 `gh` CLI 操作。See `docs/agents/issue-tracker.md`.

### Triage labels

沿用五個 canonical roles，標籤字串與角色名稱相同。See `docs/agents/triage-labels.md`.

### Domain docs

Single-context：root `CONTEXT.md` + `docs/adr/`。See `docs/agents/domain.md`.

## 驗證前置

人工驗收一律從 `npm run verify:setup` 開始，不要自己拼裝步驟。它會安裝、建置、檢查前置、
準備簡報、把 workspace 的 `node_modules/.bin` 掛上 PATH，然後啟動 serve。
兩種準備方式：不加旗標得到 e2e 的四頁 demo（驗既有行為），`--blank` 得到空白簡報
（驗從零開始的路徑）。細節與這個指令涵蓋不到的情況見 `docs/verify-setup.md`。

`npm test`（單元測試）自帶 `npm run build` 前置（root `package.json`），不需要在跑之前手動
`npm run build`；`packages/server/test/agent/` 底下會真的 shell out 到 `slidra` CLI 的測試
（`freeze.test.ts`／`agent-api.test.ts`）在 `beforeAll` 用 `requireCliBuilt()` 守住這個依賴——
繞過 `npm test` 直接 `npx vitest run <單檔>` 時若忘記先 build，會得到可讀的錯誤而不是一串
30 秒逾時。

## 驗證清單的規則

PR 的「給人類的驗證清單」裡寫出來的每一條指令，都必須**實際跑過**、貼得出真實輸出。
沒跑過就不要寫；跑了但失敗，就寫失敗的樣子，不要寫成預期的樣子。
清單的起點固定是 `npm run verify:setup`。

### 視覺回歸的把關分工

外觀基準截圖（`e2e/helpers/screenshot.ts` 的 `compareScreenshot`）必須在跟 CI 相同的 `ubuntu-latest` + Playwright 內建 Chromium 上產生，本機（尤其 macOS）產生的截圖字型渲染不同，會讓外觀測試在 CI 上假性失敗。因此：

- **CI（`.github/workflows/e2e.yml`）是外觀基準比對的權威把關者**：`npm run test:e2e` 照常逐像素比對，不跳過。
- **重產基準截圖唯一支援的方式**：手動觸發 `e2e.yml` 並勾選 `update_baselines`，跑完從 `appearance-baselines` artifact 下載結果、檢查截圖內容正確後再 commit。
- **本機執行 `npm run test:e2e` 或 `npm run visual-qa` 的外觀比對結果僅供參考**（本機字型渲染與 CI 不同，逐像素比對必然失敗），不能作為驗收證據；驗收以 CI 上的比對結果為準。
