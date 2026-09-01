# CoMotion

## Agent skills

### Issue tracker

Issues 與 PRD 以 GitHub Issues 追蹤，透過 `gh` CLI 操作。See `docs/agents/issue-tracker.md`.

### Triage labels

沿用五個 canonical roles，標籤字串與角色名稱相同。See `docs/agents/triage-labels.md`.

### Domain docs

Single-context：root `CONTEXT.md` + `docs/adr/`。See `docs/agents/domain.md`.

### 視覺回歸的把關分工

外觀基準截圖（`e2e/helpers/screenshot.ts` 的 `compareScreenshot`）是在 macOS 上產生的；CI runner 是 Ubuntu，字型光柵化不同，逐像素比對必然失敗，不是 flaky。因此：

- **CI（`.github/workflows/e2e.yml`）只跑功能性 e2e**：`SKIP_APPEARANCE_BASELINES=1` 讓截圖比對一律視為通過（顯示「已跳過」訊息），其餘測試照常執行。
- **外觀基準比對與 `npm run visual-qa` 由本機負責**（不設 `SKIP_APPEARANCE_BASELINES`，`npm run test:e2e` 照常逐像素比對）。
- **外觀變更的 PR 必須附本機全綠證據與基準更新**（`UPDATE_APPEARANCE_BASELINES=1` 重新產生基準、檢查過截圖內容後再提交）——CI 的跳過不能替代這一步。
