/**
 * 備忘稿 (New v3 skeleton)。高度由 styles/notes.css 的 `--notes-h` 決定。
 * 沒有票把真的備忘稿內容接到 CanvasState 上，這裡維持誠實的預留位置，不
 * 生造一個假的、per-slide 的備忘稿文字，也不做成看起來能編輯卻沒有東西
 * 接在後面的欄位。舊版的 `hidden`（網格檢視時隱藏）已經沒有意義——網格檢
 * 視整個被這張票拿掉了（見 PR 報告），所以這個 prop 一併移除。
 */
export function Notes() {
  return (
    <section className="notes">
      <div className="notes-label">備忘稿</div>
      <div className="notes-empty">這一頁還沒有備忘稿。</div>
    </section>
  );
}
