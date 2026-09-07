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

/**逐字文案（父票驗收條件）：agent 完全沒回報、且兩個 skill 目錄都不存在時顯示的提示。 */
const NO_COMMANDS_HINT = "這個 agent 沒有回報可用的斜線命令";

/**
 * Pure, stateless — no state, no fetch (plan §1's file table). Selection,
 * filtering, and fetching all live in ChatPanel.tsx/App.tsx; this component
 * only ever renders whatever it is handed.
 */
export function SlashMenu({ commands, selectedIndex, onSelect }: SlashMenuProps) {
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
