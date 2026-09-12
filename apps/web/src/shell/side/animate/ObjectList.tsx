import type { EffectName, EffectStart } from "../../../effects.js";
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
 * The Animate > Object list view: one card per effect item, card order equals
 * file order equals the 1-based address (D6). An empty list shows the
 * prototype's empty-state copy verbatim (`prototype/Slidra (New v3).dc.html:696`).
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
