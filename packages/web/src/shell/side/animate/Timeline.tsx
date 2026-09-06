import { useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { cardLabel, type EffectCardData } from "./cards.js";

export interface TimelineProps {
  cards: EffectCardData[];
  onMove(index: number, direction: "up" | "down"): void;
  onChangeDelay(index: number, delay: number): void;
  onChangeDuration(index: number, duration: number): void;
}

/** Pixels per second of the timeline's own time axis — an arbitrary but fixed scale (bar left/width are computed from it), not a design token: D13 explicitly carves out inline `left`/`width` px for this component ("時間軸 bar 的 left/width 用 inline style 的 px…長度不禁"). */
const PIXELS_PER_SECOND = 80;
const MIN_BAR_WIDTH = 24;
const ROW_HEIGHT = 40;
const MIN_DURATION = 0.1;

interface DragState {
  kind: "move" | "delay" | "duration";
  index: number;
  startX: number;
  startY: number;
  startDelay: number;
  startDuration: number;
  /** Only meaningful for `kind: "move"` — the net row offset the pointer has crossed into, clamped to [-1, 1] (D11: `effect move` only swaps one adjacent pair per call). */
  rowOffset: -1 | 0 | 1;
  previewDelay: number;
  previewDuration: number;
}

/**
 * Animate › Object 的時間軸視圖（NOOP-66/#206 §4.5, D11）：清單的另一種畫
 * 法——同一份卡片資料，改用 bar 的位置/寬度表達 delay/duration，拖曳即改
 * 順序或 duration/delay，不另存資料。三種拖曳都只在 `pointerup` 送一次命
 * 令（D11：`pointermove` 送命令會讓 50 筆的 undo 上限被單一手勢灌爆）；拖
 * 曳中只更新本地預覽 state，`Esc` 取消整個手勢、不送任何命令。
 */
export function Timeline({ cards, onMove, onChangeDelay, onChangeDuration }: TimelineProps) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  if (cards.length === 0) {
    return <p className="animate-object-empty">No animations on this slide.</p>;
  }

  function cancelDrag(): void {
    setDrag(null);
  }

  function beginBarDrag(event: ReactPointerEvent<HTMLDivElement>, index: number, card: EffectCardData): void {
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({
      kind: "move",
      index,
      startX: event.clientX,
      startY: event.clientY,
      startDelay: card.effect.delay,
      startDuration: card.effect.duration,
      rowOffset: 0,
      previewDelay: card.effect.delay,
      previewDuration: card.effect.duration,
    });
  }

  function beginHandleDrag(event: ReactPointerEvent<HTMLDivElement>, index: number, card: EffectCardData): void {
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({
      kind: "duration",
      index,
      startX: event.clientX,
      startY: event.clientY,
      startDelay: card.effect.delay,
      startDuration: card.effect.duration,
      rowOffset: 0,
      previewDelay: card.effect.delay,
      previewDuration: card.effect.duration,
    });
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
    if (!drag) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (drag.kind === "duration") {
      const nextDuration = Math.max(MIN_DURATION, drag.startDuration + dx / PIXELS_PER_SECOND);
      setDrag({ ...drag, previewDuration: nextDuration });
      return;
    }
    if (drag.kind === "move") {
      // Vertical cross-track (D11): only an adjacent swap per gesture — the
      // underlying `effect move` command itself only shifts one position.
      const rowOffset = dy > ROW_HEIGHT / 2 ? 1 : dy < -ROW_HEIGHT / 2 ? -1 : 0;
      // Horizontal move on the bar body sets delay (D11's own "水平拖曳 bar
      // 本體" row) — both can happen from the same gesture; whichever the
      // pointer moved further on wins visually, but both previews update.
      const nextDelay = Math.max(0, drag.startDelay + dx / PIXELS_PER_SECOND);
      setDrag({ ...drag, rowOffset: rowOffset as -1 | 0 | 1, previewDelay: nextDelay });
    }
  }

  function handlePointerUp(): void {
    if (!drag) return;
    if (drag.kind === "duration") {
      if (Math.abs(drag.previewDuration - drag.startDuration) > 1e-6) {
        onChangeDuration(drag.index, Math.round(drag.previewDuration * 100) / 100);
      }
    } else if (drag.kind === "move") {
      if (drag.rowOffset !== 0) {
        onMove(drag.index, drag.rowOffset === 1 ? "down" : "up");
      } else if (Math.abs(drag.previewDelay - drag.startDelay) > 1e-6) {
        onChangeDelay(drag.index, Math.round(drag.previewDelay * 100) / 100);
      }
    }
    setDrag(null);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape" && drag) {
      event.preventDefault();
      cancelDrag();
    }
  }

  return (
    <div
      className="animate-timeline"
      ref={containerRef}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={cancelDrag}
      onKeyDown={handleKeyDown}
      tabIndex={-1}
    >
      {cards.map((card, position) => {
        const isDragging = drag?.index === card.index;
        const delay = isDragging && drag.kind !== "duration" ? drag.previewDelay : card.effect.delay;
        const duration = isDragging && drag.kind === "duration" ? drag.previewDuration : card.effect.duration;
        const left = delay * PIXELS_PER_SECOND;
        const width = Math.max(MIN_BAR_WIDTH, duration * PIXELS_PER_SECOND);
        const rowShift = isDragging && drag.kind === "move" ? drag.rowOffset * ROW_HEIGHT : 0;
        return (
          <div className="animate-timeline-row" key={card.index}>
            <span className="animate-timeline-row-label">{cardLabel(card, position + 1)}</span>
            <div className="animate-timeline-track">
              <div
                className="animate-timeline-bar"
                data-family={card.effect.family}
                style={{ left, width, transform: rowShift ? `translateY(${rowShift}px)` : undefined }}
                onPointerDown={(event) => beginBarDrag(event, card.index, card)}
              >
                <span className="animate-timeline-bar-number">{position + 1}</span>
                <div className="animate-timeline-handle" onPointerDown={(event) => beginHandleDrag(event, card.index, card)} />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
