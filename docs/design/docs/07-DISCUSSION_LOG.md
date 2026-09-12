# 07 · 討論串紀錄（決策與否決）

按時間順序整理；「→」為採納結果，「✕」為否決或還原。

## 第一階段：從 web/ 舊版到 New
- 讀取 `web/`（React + CSS tokens 的深色 Office 式 ribbon）與 Holspire 設計語言（暖白、#C8233B、Plus Jakarta Sans、圓角卡片）。
- 問卷決策：重設計全部畫面；**暖白外殼＋深色舞台**；右側維持分頁側欄；Plus Jakarta Sans + Noto Sans TC；直接做一個高保真。
- 先重建舊版 `Slidra (Old)` 作對照，再產生 `Slidra (New)`。
- 工具列走向：分頁 pill + 單列精簡指令 + 選取時浮動情境列。

## 第二階段：AI 留言（pin）系統
- 選取框不再固定，點選才出現。
- 選框旁「留言給 agent」→ 對話欄出現對應元素（可跳轉、✕ 刪除）。
- 對話欄標注列高度縮短（30px），只顯示編號／頁數／截斷留言；最多 6.5 列可視，超過捲動。
- 整頁留言改由左欄縮圖進入（不在對話框常駐「第 N 頁」）。
- 編號從圓改為圓角方框（實心）；舞台上也要有對應編號；再次點擊可修改；對話欄與整頁留言同樣可編輯。
- 編號位置：取代對話圖示；舞台右上整頁編號移除；排序＝頁序→左上到右下。
- 編號未 hover 時透明 → 後改回實心。
- 留言框：預設在選框下方（不夠翻上方）、玻璃感、外框不要白、距離加倍、更模糊、輸入區半透明、左下文字對比提高；點已有留言的元素再按留言會帶出舊內容。

## 第三階段：介面英文化與功能補齊
- 非內容 UI 全面英文。
- 新增 Open / Save / Export（PPTX、PDF、By-frame PDF）。
- 選取框可拖曳移動與四角縮放。
- 示範頁與範本多元化：圖片、聲音、影片、表格、SVG 動畫；動畫改為自包含 SVG（keyframes 在 `<svg><style>` 內）。
- 「還有什麼沒做」建議清單 → 選定「基礎補齊」全項（多選、拖曳排序、快捷鍵、Undo/Redo、右鍵、空狀態 onboarding、雙擊編輯、輔助線吸附）；pin 閉環暫不做。
- 進一步：每物件動畫與編排、New slide 從大綱、表格可編輯、bar 獨立矩形、Text box / Shape、Arrange 實作。
- ▾ 全移除，按了直接出選單；修正 overflow:hidden 把選單裁掉的 bug。
- Table / Chart 真實作（規劃問卷後）：表格每格樣式、欄寬拖曳、範圍選取、右鍵行列合併、主題面板；圖表資料模型、6 類型、樣式、浮動資料視窗、自包含 SVG 輸出。修正 `<colgroup>` 未渲染（改用第一列 width）與資料格被壓扁（flex:none）。

## 第四階段：簡化嘗試
- 提出 10 項簡化建議。採納：刪 1280×720 chip。✕ Style+Animate 合成 Inspector（做了又還原）。
- **v2**（激進版）：無分頁工具列、右側全給聊天、屬性全部放舞台下方 Dock。做到一半使用者不喜歡 → 放棄。

## 第五階段：v3（由 New 重新產生，最終版）
- 移除 Present 分頁；Transitions 移到 Animate（Page animate：Enter/Exit；Object animate）。
- Home + Insert 平攤置中；Fullscreen/Play 併入 → 後 Play 移到頂列 Export 右側，全螢幕圖示刪除。
- 工具列位置：舞台下方 → 懸浮玻璃於舞台上方 → 最終**懸浮玻璃於舞台下方**。過程中修正寬度溢出（縮小間距、Insert 一度改純圖示又恢復標籤、tooltip 需單一 hole）。
- ✕ 左右欄也改玻璃懸浮並刪備忘稿 → 還原。
- New / Templates 移到左欄上方（白底同款）。
- 標題列：Undo/Redo 移到檔名左；檔名顯示 `.slidra`；Logo 改 CM → 刪除；agent connected 刪除；AI 頭像改 🤖。
- 情境列：移除 Left/Center/Front 與 sub 標籤；順序 Comment to AI ｜ Edit style · Edit animation ｜ Delete；箭頭移除、分隔線調整；「Comment to agent」→「Comment to AI」；Revise → **Edit**；無動畫時不顯示 Edit animation。
- pin 編號移到選框名稱標籤右側、僅選取時出現、實心。
- 留言框：刪頂部說明與左下提示；按鈕改 Save changes / Add comment 並留在框內。
- 插入類（Image/Video/Audio/Table/Chart）先詢問再插入 → 面板一律從工具列正上方中央長出 → Text 亦然（緊湊）。
- Style 分頁加入 Page（投影片尺寸）/ Object；Style、Animate 內改為 Page｜Object 子分頁（無選取時 Object 停用）；區塊標題移除。
- Shape / Arrange / Zoom 選單改左右排列。
- Table 尺寸格：hover 只預覽、click 鎖定（修正「定不住」）。
- Animate：工具列新增 Animate（與 Arrange 同段、無選取時停用），面板含效果預覽 + Start 時機 + Duration。
- Group：工具列新增 Group/Ungroup；支援巢狀；雙擊鑽入；動畫以 PPTX 方式處理（整組一段；Group/Ungroup 清除相關動畫）。
- 畫布：Figma 式縮放平移；✋ 抓取模式（lock 時投影片亦可抓、清除選取）；縮放百分比放工具列左側並展開橫向選單。
- 舞台背景 → 暗灰 → 再淺一點（#3A3A3D）。
- 使用者確認 **New v3** 為最終版本。
