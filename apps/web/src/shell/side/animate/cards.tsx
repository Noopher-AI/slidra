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
 * Animate › Object 清單的單張卡片（NOOP-66/#206 §4.5）：改 Effect／Start／
 * Duration／Delay 立即送出對應的 `effect set`（呼叫方接住 onChange* 決定何
 * 時真的 dispatch——這裡不做 debounce／樂觀更新，維持「一次操作＝一次 undo」
 * 的單純性，交給呼叫方）。`family` 不在卡片上顯示可改欄位（D3：family 只能
 * remove+add，不能 set）。
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
        <button type="button" className="animate-card-icon-button" aria-label="上移" disabled={isFirst} onClick={onMoveUp}>
          <Icon name="chevron-up" size="control" />
        </button>
        <button type="button" className="animate-card-icon-button" aria-label="下移" disabled={isLast} onClick={onMoveDown}>
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
