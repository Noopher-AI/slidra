// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { useEffect, useRef, useState } from "react";
import { fetchSlideNotes } from "../notes.js";

export interface NotesProps {
  /** Current slide number (1-based); null when there are no slides, in which case the header omits "Slide n". */
  slideNumber: number | null;
  /** Current slide's virtual path; null when there are no slides. */
  slidePath: string | null;
  /** Forwards to `CanvasController.runCommand` — sends `slide notes set` on blur. */
  onCommand: (name: string, input: Record<string, unknown>) => Promise<{ ok: boolean; message: string; data?: unknown } | undefined>;
}

type LoadState = { status: "empty" } | { status: "loading" } | { status: "ready" } | { status: "error"; message: string };

const PLACEHOLDER = "No notes for this slide yet. Add talking points — they show on your screen while presenting.";

/**
 * Speaker notes: the `Notes.tsx` textarea sends its edits via `slide notes
 * set` on blur. Reading goes through `readSlideNotes` — it doesn't use
 * `DOMParser`, so older files (missing `xmlns:slidra`) still load correctly;
 * see `notes.ts`'s file header for details.
 *
 * "No notes exist" and "notes exist but are empty" are deliberately not
 * distinguished in the UI (both show the placeholder); a read failure
 * (malformed markup, or a non-200 HTTP response) is reported explicitly and
 * sets the field to `readOnly` — an editable-looking empty field must never
 * overwrite real on-disk notes with an empty string on blur.
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
