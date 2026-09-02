# 就地編輯的游標與選取：`textarea.selectionStart/End` 是唯一事實來源，索引空間與 SVG 字元索引零偏移

## 作廢的舊決定

就地編輯原本的模型（selection-runtime.js 舊註解「§7 決定 6」，只存在於程式註解與舊 issue 的計畫留言，`docs/` 下沒有任何記錄）是：**游標永遠畫在最後一個字元之後，沒有游標移動、沒有選取**。任何一次編輯只能在字串結尾追加或刪除。這條決定在本 ADR 作廢：就地編輯現在支援方向鍵移動游標、點擊定位、拖曳選取、IME 組字，理由見下方「決定」。

## 背景

NOOP-272（#155）要求就地編輯支援游標移動與文字選取（A1–A9）：方向鍵移動、點擊定位、拖曳選取後打字取代、跨行選取的視覺、Backspace 整段刪除、IME 組字期間不亂跳、Esc 仍然 commit。這些全部要在 `packages/web/src/selection-runtime.js`——沙盒 iframe 裡那支無 import、無 export、不能引用 `@co-motion/core` 的 runtime（ADR-0011）——的既有編輯模型上加上去。

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

## 決定四：跨行選取每行各自一塊，不做行間插值

`.edit-selection` 的每一塊 top/height 一律取該行自己 `<tspan>` 的 `getBoundingClientRect()`，绝不用「上一行 bottom 到下一行 top」插值推算——那正是接縫處破洞或重疊的來源。中間整行被完整選取時，左右邊界取該行第一/最後一個字元的 start/end x，不是 tspan 的完整 client rect（換行處不可見的行尾空白不畫出突出的反白）。

## Consequences

- `selection-runtime.js` 新增 `indexAtPoint()`、`textLineRanges()`、`caretRectForIndex()`、`selectionRectsForRange()` 等純幾何 helper，`updateEditDecoration()` 改為讀 `textarea.selectionStart/End` 決定畫 caret 還是畫選取塊。
- 新增文字選取拖曳狀態機（`textSelectDrag`）：`pointerdown` 落在被編輯元素內部時，若非 IME 組字中，改為用 `indexAtPoint()` 設定 `selectionStart/End` 並呼叫 `event.preventDefault()`（避免瀏覽器預設的 mousedown 行為把焦點從隱藏 `<textarea>` 移走），而不是像舊版一樣單純忽略。
- IME 組字期間（`isComposing === true`）：`Escape` 不再攔截 commit（讓 IME 自己處理候選字的取消），`pointerdown` 落在被編輯元素內部一律忽略，不改變 `selectionStart/End`。
- `getScreenCTM()`／`getNumberOfChars()` 在 jsdom（本 repo 用於非 layout 的單元測試）完全未實作——每個讀取它們的路徑都先過 `getTextCTM()` 這唯一守門點，缺 API 時回傳 `null` 而不是丟例外，讓涉及 `editingId !== null` 的狀態機測試仍能在 jsdom 跑，幾何相關的斷言則專屬 e2e（`e2e/text-edit.test.ts`）。
- 不支援 surrogate pair（emoji、CJK 擴充 B 平面）的逐字定位：SVG 字元索引以 UTF-16 code unit 編號，定位可能落在 pair 中間。這是已知限制，不加特例。
- 不做上/下方向鍵的視覺行導覽、不做雙擊選字/三擊選行、不做游標水平捲動——這些沿用 `<textarea>` 原生行為或明確排除在本票範圍外。
