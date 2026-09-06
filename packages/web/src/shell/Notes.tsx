import { useEffect, useRef, useState } from "react";
import { fetchSlideNotes } from "../notes.js";

export interface NotesProps {
  /** 目前頁碼（1-based）；沒有投影片時為 null，標題列就不顯示「Slide n」。 */
  slideNumber: number | null;
  /** 目前頁的虛擬路徑；沒有投影片時為 null。 */
  slidePath: string | null;
  /** `CanvasController.runCommand` 的轉發——blur 時送 `slide notes set`。 */
  onCommand: (name: string, input: Record<string, unknown>) => Promise<{ ok: boolean; message: string; data?: unknown } | undefined>;
}

type LoadState = { status: "empty" } | { status: "loading" } | { status: "ready" } | { status: "error"; message: string };

const PLACEHOLDER = "No notes for this slide yet. Add talking points — they show on your screen while presenting.";

/**
 * 備忘稿：`Notes.tsx` 的 textarea，blur 時把改動送 `slide notes set`
 * （T3 plan §4.1）。讀取走 `readSlideNotes`——不用 `DOMParser`，舊檔（沒有
 * `xmlns:comot`）也讀得回來，見 `notes.ts` 的檔頭說明。
 *
 * 「不存在」與「存在但為空」在 UI 上刻意不分（都顯示 placeholder）；
 * 讀取失敗（markup 壞掉／HTTP 非 200）則明確報錯並把欄位設成
 * `readOnly`——絕不能讓一個看起來可編輯的空欄位在 blur 時把磁碟上真正的
 * 備忘稿覆寫成空字串。
 */
export function Notes({ slideNumber, slidePath, onCommand }: NotesProps) {
  const [state, setState] = useState<LoadState>(slidePath ? { status: "loading" } : { status: "empty" });
  const [draft, setDraft] = useState("");
  const draftRef = useRef(draft);
  draftRef.current = draft;
  // The slidePath/text this component last knows to be saved on disk. Null
  // whenever there is nothing safe to compare a blur against (no slide,
  // still loading, or the load failed) — flushIfChanged() must not fire in
  // any of those states.
  const loadedSlidePathRef = useRef<string | null>(null);
  const loadedTextRef = useRef<string | null>(null);

  function flushIfChanged(): void {
    const path = loadedSlidePathRef.current;
    if (path === null || loadedTextRef.current === null) return;
    const text = draftRef.current;
    if (text === loadedTextRef.current) return;
    loadedTextRef.current = text;
    void onCommand("slide notes set", { slidePath: path, text });
  }

  useEffect(() => {
    // Flushes the PREVIOUS slidePath's unsent edit before switching — the
    // refs below still hold the old slide's data at this point, since
    // nothing has been reset for the new slidePath yet.
    flushIfChanged();

    loadedSlidePathRef.current = null;
    loadedTextRef.current = null;

    if (!slidePath) {
      setState({ status: "empty" });
      setDraft("");
      return;
    }

    let cancelled = false;
    setState({ status: "loading" });
    void fetchSlideNotes(slidePath).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        loadedSlidePathRef.current = slidePath;
        loadedTextRef.current = result.text;
        setDraft(result.text);
        setState({ status: "ready" });
      } else {
        setState({ status: "error", message: result.error });
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slidePath]);

  const disabled = state.status === "empty" || state.status === "loading";
  const readOnly = state.status === "error";
  const value = state.status === "ready" ? draft : "";

  return (
    <section className="notes">
      <div className="notes-label">
        Speaker notes
        {slideNumber !== null && <span className="notes-label-slide">Slide {slideNumber}</span>}
      </div>
      {state.status === "error" && (
        <div className="notes-error" role="alert">
          {state.message}
        </div>
      )}
      <textarea
        className="notes-textarea"
        aria-label="Speaker notes"
        placeholder={PLACEHOLDER}
        value={value}
        disabled={disabled}
        readOnly={readOnly}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={flushIfChanged}
      />
    </section>
  );
}
