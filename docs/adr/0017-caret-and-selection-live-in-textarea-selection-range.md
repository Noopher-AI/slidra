# 就地編輯的游標與選取：`textarea.selectionStart/End` 是唯一事實來源，索引空間與 SVG 字元索引零偏移

## 作廢的舊決定

就地編輯原本的模型（selection-runtime.js 舊註解「§7 決定 6」，只存在於程式註解與舊 issue 的計畫留言，`docs/` 下沒有任何記錄）是：**游標永遠畫在最後一個字元之後，沒有游標移動、沒有選取**。任何一次編輯只能在字串結尾追加或刪除。這條決定在本 ADR 作廢：就地編輯現在支援方向鍵移動游標、點擊定位、拖曳選取、IME 組字，理由見下方「決定」。

## 背景

NOOP-272（#155）要求就地編輯支援游標移動與文字選取（A1–A9）：方向鍵移動、點擊定位、拖曳選取後打字取代、跨行選取的視覺、Backspace 整段刪除、IME 組字期間不亂跳、Esc 仍然 commit。這些全部要在 `apps/web/src/selection-runtime.js`——沙盒 iframe 裡那支無 import、無 export、不能引用 `@slidra/core` 的 runtime（ADR-0011）——的既有編輯模型上加上去。

## 決定一：`textarea.selectionStart`/`selectionEnd` 是游標與選取的唯一事實來源

runtime 早已有一個隱藏的 `<textarea>` 捕捉鍵盤輸入（`ensureTextarea()`）。與其在 runtime 裡另外維護一份游標/選取索引（兩份狀態，兩份要同步的邏輯），本 ADR 選擇讓 `<textarea>` 原生的 `selectionStart`/`selectionEnd` 直接就是唯一事實來源：方向鍵移動、輸入取代選取、Backspace 刪除選取、IME 組字，全部沿用 `<textarea>` 的原生行為，runtime 只需要做兩件事——把 `selectionStart/End` 換算成螢幕矩形畫出來（`indexAtPoint`/`updateEditDecoration`），以及把滑鼠點擊/拖曳換算成索引寫回 `selectionStart/End`。

放棄的選項：runtime 自己維護一份游標索引，鍵盤事件時手動更新。放棄理由是這等於重新實作 `<textarea>` 免費附贈的整套鍵盤導覽（方向鍵、Home/End、Shift+方向鍵擴選、Ctrl/Cmd+A），且兩份狀態一旦不同步，bug 沒有機械證明方式抓得到。

## 決定二：SVG 字元索引空間與 `textarea.value` 的索引空間零偏移，不做任何空白補償

這是 A6「西文含空白斷行的文字方塊，游標索引與實際字元位置一致」得以只用 `<textarea>` 索引直接定位、不用另外查表的前提，必須先證明成立：

- `packages/core/src/text/wrap.ts` 的字元保存不變式（該檔 header 明寫）：`wrapText` 永不刪字元，換行處的空白留在前一行行尾，`lines.map(l => l.text).join("")` 逐位元組還原輸入。`packages/core/test/text-wrap.test.ts:71` 是這條斷言的測試。
- `<text>` 一律帶 `xml:space="preserve"`（`packages/core/src/workspace.ts:477`），`renderTextBoxContent` 產生的 tspan 之間沒有任何額外空白字元，瀏覽器不做空白摺疊。

因此每個 `<tspan>` 的 textContent 依序串接 === 原始字串，`SVGTextContentElement.getStartPositionOfChar(i)`/`getEndPositionOfChar(i)`（跨越同一個 `<text>` 底下所有 `<tspan>` 連續編號，已用 Playwright 對 Chromium 實測驗證）的索引空間與 `textarea.value` 的字元索引空間完全相同，偏移恆為 0。換行處的空白只是視覺上落在框外／不可見，索引照算，仍然可以被點到、可以被選取。

放棄的選項：在 `indexAtPoint()`／`caretRectForIndex()` 裡加一層「跳過換行處被吃掉的空白」的位移補償。放棄理由是這個補償要修正的問題根本不存在（空白從未被吃掉），寫這段程式碼只會凴空造出一個 off-by-one 來源。

## 決定三：本票是純 runtime 改動，`canvas.ts` 零改動

host（`canvas.ts`）在 `begin-text-edit` 時已把整段字串送進 runtime，隱藏的 `<textarea>` 從那一刻起就是字串的持有者；游標與選取是純粹的 runtime 內部繪製狀態，host 不需要知道，也不需要新的 postMessage 訊息種類。`SELECT_AFTER_COMMAND`（`canvas.ts:957`/`971`）是另一票（T9/#156）的地盤，本票未觸碰。

**範圍澄清（NOOP-65 補述）**：這條決定的範圍僅限本 ADR 原本涵蓋的 NOOP-272（#155）。NOOP-65（多行富文字框）確實改了 `canvas.ts`——四角把手在文字框上改送 `textbox width`（純前端把手映射，見決定五之後的說明）——但輸入元件本身**沒有**搬到父文件：`<textarea>` 仍在 runtime 的 shadow root 內，「決定一」在本票下原封不動成立。NOOP-65 的計畫曾拍板要把輸入元件搬到父文件（讓未來的父文件富文字控制項不必在點擊時打斷編輯），但本輪判斷：搬遷是最高風險的一步，且本票本身不新增任何父文件層級的富文字控制項（Text 插入面板只在「未編輯」狀態下出現，插入與編輯是兩個不重疊的時刻），沒有東西會在編輯中被點到而搶走 iframe 焦點——因此這一步延後，留給下一張需要父文件控制項的票再做，不在本票勉強推進。

## 決定四：跨行選取每行各自一塊，不做行間插值

`.edit-selection` 的每一塊 top/height 一律取該行自己 `<tspan>` 的 `getBoundingClientRect()`，绝不用「上一行 bottom 到下一行 top」插值推算——那正是接縫處破洞或重疊的來源。中間整行被完整選取時，左右邊界取該行第一/最後一個字元的 start/end x，不是 tspan 的完整 client rect（換行處不可見的行尾空白不畫出突出的反白）。

## 決定五：多行與片段之後，索引空間仍然零偏移——但 DOM 索引與 `textarea.value` 索引不再永遠相等（NOOP-65 補述）

「決定二」證明的是 SVG 字元索引（`getStartPositionOfChar`/`getEndPositionOfChar`）與 DOM 字元序列零偏移——這件事在硬換行、富文字、列表符號都加進來之後**依然成立**，三者都不改變任何一個字元在 DOM 裡的順序或存在與否。但「決定二」原本額外斷言「DOM 索引空間 = `textarea.value` 索引空間」，這一條在硬換行出現後**不再成立**，理由分三點：

1. **硬換行字元 `\n` 不進任何 tspan 內容**（NOOP-65 決定 A）：由 `data-slidra-break="1"` 標記行尾，`\n` 本身沒有 DOM 位置。`textarea.value` 的索引空間 = Σ(每行內容長度 + 該行是否硬換行)；DOM 索引空間 = 單純的字元計數，不含硬換行。兩者從第一個硬換行之後就永久錯開一位，且每多一個硬換行多錯一位。
2. **富文字的 run 切段是巢狀 tspan**（NOOP-65 決定 B）：不改變字元順序、不插入任何字元，因此對兩個索引空間都是零影響——巢狀本身不是索引空間分歧的原因，只有硬換行才是。
3. **列表符號是同一個 `<g>` 內另一個帶 `data-slidra-list-marker` 的 `<text>`**（NOOP-65 決定 E）：符號本身在另一個完全獨立的 `<text>` 元素裡，既不進內容 `<text>` 的 DOM 字元序列，也不進 `textarea.value`；`selection-runtime.js` 每一處「找內容 `<text>`」都經 `contentTextElement()` 排除這個 marker，避免它的存在干擾任何一個索引空間的計算。

因此 `selection-runtime.js` 的 `textLineRanges()` 現在對每一行回報兩組計數，`domStart/domEnd`（餵給 `getStartPositionOfChar`/`getEndPositionOfChar`）與 `valueStart/valueEnd`（`textarea.selectionStart/End` 所在的空間），只在行尾差一位（該行是否 `hardBreak`）；`indexAtPoint()` 對外仍然只回傳 value 索引（`textarea.selectionStart` 要的那個），`caretRectForIndex()`/`selectionRectsForRange()` 收的參數也維持 value 索引，內部才轉成 domIndex 去查詢 SVG 幾何——呼叫端完全不需要知道這個轉換存在。

放棄的選項：在硬換行處往 DOM 裡插入一個不可見字元（例如零寬空白）撐住索引，讓兩個空間繼續相等。放棄理由與 NOOP-65 計畫 §7-A 相同：這個字元會被 `measureTextWidth` 量進行寬，對齊時每段最後一行的位置會偏掉，而且瀏覽器對這類字元的 `getNumberOfChars()` 計數行為未經驗證，換一個問題不是解決問題。

## Consequences

- `selection-runtime.js` 新增 `indexAtPoint()`、`textLineRanges()`、`caretRectForIndex()`、`selectionRectsForRange()` 等純幾何 helper，`updateEditDecoration()` 改為讀 `textarea.selectionStart/End` 決定畫 caret 還是畫選取塊。
- 新增文字選取拖曳狀態機（`textSelectDrag`）：`pointerdown` 落在被編輯元素內部時，若非 IME 組字中，改為用 `indexAtPoint()` 設定 `selectionStart/End` 並呼叫 `event.preventDefault()`（避免瀏覽器預設的 mousedown 行為把焦點從隱藏 `<textarea>` 移走），而不是像舊版一樣單純忽略。
- IME 組字期間（`isComposing === true`）：`Escape` 不再攔截 commit（讓 IME 自己處理候選字的取消），`pointerdown` 落在被編輯元素內部一律忽略，不改變 `selectionStart/End`。
- `getScreenCTM()`／`getNumberOfChars()` 在 jsdom（本 repo 用於非 layout 的單元測試）完全未實作——每個讀取它們的路徑都先過 `getTextCTM()` 這唯一守門點，缺 API 時回傳 `null` 而不是丟例外，讓涉及 `editingId !== null` 的狀態機測試仍能在 jsdom 跑，幾何相關的斷言則專屬 e2e（`e2e/text-edit.test.ts`）。
- 不支援 surrogate pair（emoji、CJK 擴充 B 平面）的逐字定位：SVG 字元索引以 UTF-16 code unit 編號，定位可能落在 pair 中間。這是已知限制，不加特例。
- 不做上/下方向鍵的視覺行導覽、不做雙擊選字/三擊選行、不做游標水平捲動——這些沿用 `<textarea>` 原生行為或明確排除在本票範圍外。
- NOOP-65：編輯中按 `Enter`（無修飾鍵）不再 `preventDefault()`——`<textarea>` 原生行為直接在游標處插入 `\n`，核心的 `wrapText` 現在認得這個字元（決定五）；`⌘Enter`/`Ctrl+Enter` 是唯一的例外，`preventDefault()` 且不冒泡，不插入、不 commit、不離開編輯。未編輯、選取恰好一個文字元素時按 `Enter`（無修飾鍵）進入編輯，重用既有的 `dblclick-textbox` 訊息與 `begin-text-edit` 迴路（含它自己的鎖定拒絕），不在這個新入口重新判斷一次鎖定規則。
