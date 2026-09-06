import type { EffectName, EffectStart } from "@co-motion/core/effects";
import { EffectCard, type EffectCardData } from "./cards.js";

export interface ObjectListProps {
  cards: EffectCardData[];
  onChangeEffect(index: number, effect: EffectName): void;
  onChangeStart(index: number, start: EffectStart): void;
  onChangeDuration(index: number, duration: number): void;
  onChangeDelay(index: number, delay: number): void;
  onMove(index: number, direction: "up" | "down"): void;
  onRemove(index: number): void;
  onPreview(index: number): void;
}

/**
 * Animate › Object 的清單視圖（NOOP-66/#206 §4.5）：一張卡一個效果項，順序
 * 即檔案順序即 1-based 位址（D6）。空清單顯示原型的空態文案，一字不改
 * （`prototype/CoMotion (New v3).dc.html:696`）。
 */
export function ObjectList({ cards, onChangeEffect, onChangeStart, onChangeDuration, onChangeDelay, onMove, onRemove, onPreview }: ObjectListProps) {
  if (cards.length === 0) {
    return <p className="animate-object-empty">No animations on this slide.</p>;
  }
  return (
    <div className="animate-object-list">
      {cards.map((card, position) => (
        <EffectCard
          key={card.index}
          card={card}
          cardNumber={position + 1}
          isFirst={position === 0}
          isLast={position === cards.length - 1}
          onChangeEffect={(effect) => onChangeEffect(card.index, effect)}
          onChangeStart={(start) => onChangeStart(card.index, start)}
          onChangeDuration={(duration) => onChangeDuration(card.index, duration)}
          onChangeDelay={(delay) => onChangeDelay(card.index, delay)}
          onMoveUp={() => onMove(card.index, "up")}
          onMoveDown={() => onMove(card.index, "down")}
          onRemove={() => onRemove(card.index)}
          onPreview={() => onPreview(card.index)}
        />
      ))}
    </div>
  );
}
