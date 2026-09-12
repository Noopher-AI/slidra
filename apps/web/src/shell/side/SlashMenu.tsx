// Copyright 2026 Noopher AI
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef } from "react";
import type { SlashCommandOption } from "../../slash-commands.js";

export interface SlashMenuProps {
  /**
   * The already-filtered list to render. An empty array means "genuinely
   * nothing available" (the caller only mounts this component at all when
   * either the full list is empty or filtering left at least one item —
   * see ChatPanel.tsx) — this component reacts to that by showing the
   * fixed hint text instead of an empty `<ul>`.
   */
  commands: readonly SlashCommandOption[];
  selectedIndex: number;
  onSelect(command: SlashCommandOption): void;
}

/** Exact copy required: shown when the agent reports nothing at all and neither skill directory exists. */
const NO_COMMANDS_HINT = "This agent has not reported any slash commands";

/**
 * Pure, stateless — no state, no fetch (plan §1's file table). Selection,
 * filtering, and fetching all live in ChatPanel.tsx/App.tsx; this component
 * only ever renders whatever it is handed.
 */
export function SlashMenu({ commands, selectedIndex, onSelect }: SlashMenuProps) {
  const selectedRef = useRef<HTMLLIElement | null>(null);
  // Keyboard selection can walk past the visible window (the list scrolls);
  // `block: "nearest"` scrolls only when the item is actually out of view,
  // so moving between two visible items never jumps the list around.
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (commands.length === 0) {
    return (
      <div className="slash-menu">
        <p className="slash-menu-empty">{NO_COMMANDS_HINT}</p>
      </div>
    );
  }
  return (
    <ul className="slash-menu" role="listbox">
      {commands.map((command, index) => (
        <li
          key={command.name}
          ref={index === selectedIndex ? selectedRef : undefined}
          role="option"
          aria-selected={index === selectedIndex}
          className={`slash-menu-item${index === selectedIndex ? " slash-menu-item-selected" : ""}`}
          // mousedown (not click) + preventDefault: selecting a menu item
          // must not steal focus from the chat input, or the author would
          // have to click back into it before typing again.
          onMouseDown={(event) => {
            event.preventDefault();
            onSelect(command);
          }}
        >
          <span className="slash-menu-item-name">/{command.name}</span>
          {command.description !== "" && <span className="slash-menu-item-description">{command.description}</span>}
        </li>
      ))}
    </ul>
  );
}
