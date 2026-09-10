# 03 · UI Rationale — 每個區塊、每個介面背後的意義

## A. 標題列（Titlebar）
| 元件 | 意義 / 決策 |
|---|---|
| `CoMotion` + `BETA` | 品牌僅文字，Logo 方塊經討論移除（資訊價值低）。 |
| ↶ ↷ | 放在檔名左側、緊鄰內容——「歷史屬於這份檔案」。凍結時停用並 toast。 |
| `檔名.comot` | 顯示副檔名以強化「這是一個檔案、由 agent 以 CLI 操作」的心智；`Saved · just now` / `Unsaved changes` 即時反映 dirty。 |
| `Agent editing · undo paused` | 凍結態明示：agent 寫檔期間人類不能回退，避免衝突。 |
| Open / Save / Export | 檔案動作集中右側。Export 提供 PPTX、PDF、By-frame PDF（每個動畫步一頁）——後者是動畫簡報的關鍵輸出。 |
| ▶ Play ▏▶| | 主要 CTA 紅色，分裂鈕：從目前頁／從頭。移到頂列右端是因為「放映」屬檔案層級，不是編輯工具。 |

## B. 左欄（Rail）
| 元件 | 意義 |
|---|---|
| New / Templates | 新頁與範本屬「頁」的操作，故放在頁清單上方而非編輯工具列。New 展開版面清單（含 From outline… AI 起手）。 |
| 縮圖 | 以真實元素（cqw 定位）縮放繪製，不是截圖——永遠與內容同步。 |
| 頁碼圓點 | 當前頁紅底白字；`✦ n` 標示該頁動畫數。 |
| 右上留言鈕 | 對「整頁」留言給 AI；有留言時顯示 pin 編號。滑入才顯示，避免噪音。 |
| 拖曳排序 | 紅色插入線；可拖到最後一格。右鍵：新增／複製／留言／上移下移／刪除／從大綱新增。 |

## C. 舞台（Stage well）
| 元件 | 意義 |
|---|---|
| 深灰背景 + 投影片 | 深底突出內容色彩；灰而非黑以免與黑色投影片邊界消失。 |
| Figma 式縮放平移 | ⌘滾輪縮放（以游標為中心）、滾輪平移、Space／✋ 抓取。編輯細節與總覽同一畫布，不需另開檢視。 |
| 選取框 | 紅描邊、四角把手、左上名稱標籤；多選虛線、整組實線。名稱標籤旁附該元素的 pin 編號（只在選取時出現）。 |
| 輔助線 | 拖曳時吸附到畫面邊／中線／其他元素邊與中心；⌥ 暫時關閉。 |
| 情境列（玻璃） | 出現在選框正下方（不夠空間翻到上方），內容依序：Comment to AI ｜ Edit style · Edit animation（有動畫才出現）｜ Delete。移除 Left/Center/Front 等可由 Arrange 或右鍵完成的操作，讓它只保留「下一步最可能做的事」。 |
| 留言框（玻璃） | 從選框長出；只留輸入與動作，去掉冗餘說明。 |
| pin 編號 | 紅色圓角方塊，與對話欄的「Pinned context」一一對應，可點擊跳轉。 |
| 雙擊 | 文字→就地編輯；圖表→資料視窗；群組→鑽入下一層。 |

### 覆蓋層只有兩層

舞台覆蓋層收斂成兩層：`.stage-geometry`（幾何層）是所有「畫給人看、不接受操作」的東西——名稱標籤旁的視覺、吸附輔助線、動畫編號徽章；`.stage-widgets`（widget 層）是所有「要按的」東西——情境列、留言 pin 與留言框、儲存格編輯框／欄寬把手／右鍵選單、Chart 資料視窗、第三方播放器。

這是結構，不是慣例：幾何層以 `pointer-events: none !important` 強制，個別元件沒有辦法把自己開回可點。舊做法是每個元件自己決定要不要吃事件，於是「顯示用的動畫徽章開了 `auto`，蓋住元素左上的縮放把手」這種錯誤寫得出來也看不出來（F-16）。分層之後這一類錯誤在結構上不存在。

widget 層的規則：widget 不得蓋住投影片內容，或自己處理 hover（情境列走後者）。明示例外：第三方播放器 iframe 被 sandbox（ADR-0011）逼到父文件，只能待在 widget 層；另有三個顯示用元素因為與可互動的兄弟節點由同一個元件渲染而留在 widget 層，但一律維持 `pointer-events: none`（名稱標籤列、播放器容器、儲存格範圍框）。

舞台覆蓋層只有兩個 z 值（幾何 1、widget 2），widget 之間的前後順序由 widget 層內部決定。

## D. 底部玻璃工具列
| 段 | 元件 | 意義 |
|---|---|---|
| 左 | ✋ 抓取 / `100%` | 畫布導航工具；✋ lock 後整個舞台（含投影片）可拖，同時清除選取避免誤操作。百分比展開橫向縮放選單。 |
| 中 | Text Shape Image Video Audio Table Chart | 「插入」是編輯的第一步，放在最容易到達的中央。全部先詢問再插入（避免先產生佈局垃圾），面板一律從工具列正上方中央長出。 |
| 右 | Animate Arrange Group | 作用於選取的操作；無選取時停用。Animate 面板含效果預覽、Start 時機、時長；Group/Ungroup 依選取狀態切換。三者之間不加分隔線以表示同類。 |

為何浮在舞台上：頂列已被檔案動作佔用；固定在舞台下方會壓縮舞台高度；浮動玻璃在任何縮放下都貼近工作區，且舞台下方保留 76px 讓情境列不會與之相撞。

## E. 右欄（Side panel）
| 分頁 | 意義 |
|---|---|
| Chat | AI 是主角，保留獨立分頁。訊息三種：使用者、agent、指令卡（Done／Running 狀態 + 目標檔）。底部「Pinned context」以 30px 一列堆疊（最多 6.5 列可視，超過捲動），排序＝頁序→位置左上到右下；輸入框顯示 `n pinned` 提示這些會一起送出。 |
| Style › Page | 投影片尺寸（16:9／4:3／16:10／A4／自訂）——屬整份 deck。 |
| Style › Object | 依元素類型顯示：文字（字級、粗細、色、對齊、位置）、表格（主題、表頭、框線、儲存格：粗體／對齊／填色／文字色／合併）、圖表（位置＋圖表資料視窗入口）。無選取時 disabled 並自動回 Page。 |
| Animate › Page | Enter／Exit 效果與時長、Apply to all。將「轉場」改名為頁面動畫並與物件動畫並列，是為了把「動畫」概念統一。 |
| Animate › Object | 卡片清單＝點擊順序；群組動畫顯示為一張卡（PPTX 行為）。Preview 播整頁序列。 |

## F. 備忘稿
保留在舞台正下方（原 web/ 位置）；播放時給講者看。

## G. 狀態列
選取名稱 chip、快捷鍵提示、頁碼與 ‹ ›、檢視切換（Normal／Grid／Play）。Grid 為總覽覆蓋層。

## H. 對話框／面板
| 面板 | 意義 |
|---|---|
| Insert Text | 文字內容 + 樣式預設（Title/Subtitle/Body/Caption）+ 對齊；Enter 直接插入。 |
| Insert Image/Video/Audio | 拖放或選檔、URL、caption（給 AI 的 context）；留空插入占位。 |
| Insert Table | 8×6 格點選尺寸（hover 預覽、click 鎖定）、主題、表頭。 |
| Insert Chart | 類型、系列數、類別數、調色盤；插入帶樣本資料。 |
| Animate | 效果卡（循環預覽）、Start、Duration → Add animation。 |
| Chart data（浮動視窗） | 類型列、資料格（類別 × 系列）、調色盤／圖例／格線／標籤／軸標題、Copy SVG。可拖曳。 |
| Templates | 版面卡片、儲存目前頁為範本。 |
| From outline | 貼大綱 → agent 草擬（縮排為副標）。空狀態亦以此起手。 |

## I. 播放模式
黑底全幅；底部膠囊控制列（‹ 頁碼·步數 › ｜全螢幕｜Exit）；點畫面或 → 前進一步（物件動畫步→頁）；頁面 Enter／Exit 動畫實際播放。

## J. 右鍵選單
元素：Edit text／Edit chart data／Add·Edit animation／Comment／前後層四項／Duplicate／Delete。縮圖：New below／From outline／Duplicate／Comment／Move up·down／Delete。表格儲存格：Edit／Bold／插列插欄／合併／刪列刪欄。
