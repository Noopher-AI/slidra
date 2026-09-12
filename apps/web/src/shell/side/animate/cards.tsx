// Copyright 2026 Noopher AI
// SPDX-License-Identifier: Apache-2.0

import { SUPPORTED_EFFECTS, SUPPORTED_STARTS, type EffectName, type EffectStart } from "../../../effects.js";
import { Icon } from "../../../icons/index.js";
import type { Effect } from "../../../effects.js";
import type { TargetInfo } from "./useSlideEffects.js";

/** One Animate › Object card's full data — the flat effect item it edits, plus display-only info `parseEffects` itself does not carry. */
export interface EffectCardData {
  /** This item's 0-based position in the slide's own effect list (`Effect.index`, D8) — `index + 1` is the 1-based address every `effect` CLI command uses (D6). */
  index: number;
  effect: Effect;
  /** Set only when `effect.target` is an actual group `<g>` (D5) — renders "Group N (n)" instead of a name/id. */
  group: { memberCount: number } | null;
  targetName: string | null;
}

export function buildCards(effects: readonly Effect[], targetInfo: ReadonlyMap<string, TargetInfo>): EffectCardData[] {
  return effects.map((effect) => {
    const info = targetInfo.get(effect.target);
    const group = info?.groupMemberCount != null ? { memberCount: info.groupMemberCount } : null;
    return { index: effect.index, effect, group, targetName: info?.name ?? null };
  });
}

export function cardLabel(card: EffectCardData, cardNumber: number): string {
  if (card.group) return `Group ${cardNumber} (${card.group.memberCount})`;
  return card.targetName ?? card.effect.target;
}

export interface EffectCardProps {
  card: EffectCardData;
  /** 1-based position among the VISIBLE cards (Object list order == file order, so this is also the badge number) — distinct from `card.index`, which is 0-based and used for CLI/preview addressing. */
  cardNumber: number;
  isFirst: boolean;
  isLast: boolean;
  onChangeEffect(effect: EffectName): void;
  onChangeStart(start: EffectStart): void;
  onChangeDuration(duration: number): void;
  onChangeDelay(delay: number): void;
  onMoveUp(): void;
  onMoveDown(): void;
  onRemove(): void;
  onPreview(): void;
}

/**
 * A single card in the Animate > Object list: changing Effect/Start/Duration/
 * Delay immediately fires the corresponding `effect set` (the caller receives
 * onChange* and decides when to actually dispatch — no debounce or optimistic
 * update happens here, keeping the "one action = one undo" simplicity in the
 * caller's hands). `family` has no editable field on the card (D3: family can
 * only be removed+added, never set).
 */
export function EffectCard({
  card,
  cardNumber,
  isFirst,
  isLast,
  onChangeEffect,
  onChangeStart,
  onChangeDuration,
  onChangeDelay,
  onMoveUp,
  onMoveDown,
  onRemove,
  onPreview,
}: EffectCardProps) {
  const { effect } = card;
  const effectOptions = SUPPORTED_EFFECTS[effect.family];
  return (
    <div className="animate-card" data-family={effect.family}>
      <div className="animate-card-header">
        <span className="animate-card-number" aria-hidden="true">
          {cardNumber}
        </span>
        <span className="animate-card-label">{cardLabel(card, cardNumber)}</span>
        <button type="button" className="animate-card-icon-button" aria-label="Move Up" disabled={isFirst} onClick={onMoveUp}>
          <Icon name="chevron-up" size="control" />
        </button>
        <button type="button" className="animate-card-icon-button" aria-label="Move Down" disabled={isLast} onClick={onMoveDown}>
          <Icon name="chevron-down" size="control" />
        </button>
        <button type="button" className="animate-card-icon-button" aria-label="Preview" onClick={onPreview}>
          <Icon name="play" size="control" />
        </button>
        <button type="button" className="animate-card-icon-button animate-card-remove" aria-label="Remove" onClick={onRemove}>
          <Icon name="close" size="control" />
        </button>
      </div>
      <div className="animate-card-fields">
        <label className="animate-card-field">
          <span>Effect</span>
          <select value={effect.effect} onChange={(event) => onChangeEffect(event.target.value as EffectName)}>
            {effectOptions.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label className="animate-card-field">
          <span>Start</span>
          <select value={effect.start} onChange={(event) => onChangeStart(event.target.value as EffectStart)}>
            {SUPPORTED_STARTS.map((start) => (
              <option key={start} value={start}>
                {start}
              </option>
            ))}
          </select>
        </label>
        <label className="animate-card-field">
          <span>Duration</span>
          <input
            type="number"
            min={0}
            step={0.1}
            value={effect.duration}
            onChange={(event) => onChangeDuration(Number(event.target.value))}
          />
        </label>
        <label className="animate-card-field">
          <span>Delay</span>
          <input
            type="number"
            min={0}
            step={0.1}
            value={effect.delay}
            onChange={(event) => onChangeDelay(Number(event.target.value))}
          />
        </label>
      </div>
    </div>
  );
}
