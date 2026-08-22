/**
 * Pure message-list operations for the chat sidebar (ticket #6, fix 3).
 *
 * Kept separate from App.tsx so the identity fix — a `chat-chunk` updates
 * the specific agent message it belongs to, never "whatever is last" —
 * is testable without rendering React.
 */

/** Something someone said: the author's own message, or the agent's reply text. */
export interface SpeechMessage {
  /** Stable identity, assigned once at creation. Never recomputed from position. */
  id: number;
  role: "author" | "agent";
  text: string;
}

/** ACP's own tool-call status, passed through verbatim — the UI translates it, the data does not. */
export type CommandStatus = "pending" | "in_progress" | "completed" | "failed";

/**
 * A command the agent ran (ticket #17). Deliberately not a `SpeechMessage`
 * with a role of "command": a command is not something anybody said, and
 * squeezing it into `text` would mean re-rendering its status by rewriting
 * a string, and re-deriving the command from that string later. It carries
 * its own fields instead, and its own ACP-assigned identity (`toolCallId`)
 * — which is what later status updates address it by, since a
 * `tool_call_update` names only the tool call, never a position in this
 * list.
 */
export interface CommandMessage {
  /** Same id space as SpeechMessage: this is the list's ordering/React key. */
  id: number;
  role: "command";
  /** ACP's `toolCallId` — the identity every later update addresses. */
  toolCallId: string;
  /** Verbatim from ACP's `rawInput.command`. Never reassembled here. */
  command: string;
  status: CommandStatus;
  /** Present only when the command failed — its own output, shown to the author as-is. */
  output?: string;
}

export type ChatMessage = SpeechMessage | CommandMessage;

/** Appends a brand-new message (author or agent) with the given id. */
export function appendMessage(
  messages: ChatMessage[],
  id: number,
  role: SpeechMessage["role"],
  text: string,
): ChatMessage[] {
  return [...messages, { id, role, text }];
}

/**
 * Appends `text` to the agent message identified by `id`. Addressed by
 * identity, not by array position — if the author sent a second message
 * after the reply started, that message is now the last item in the list,
 * but this still finds and updates only the agent's own message.
 */
export function appendChunkToMessage(messages: ChatMessage[], id: number, text: string): ChatMessage[] {
  return messages.map((message) =>
    message.id === id && message.role !== "command" ? { ...message, text: message.text + text } : message,
  );
}

/** Appends a command the agent has started running. */
export function appendCommandMessage(
  messages: ChatMessage[],
  id: number,
  toolCallId: string,
  command: string,
  status: CommandStatus,
): ChatMessage[] {
  return [...messages, { id, role: "command", toolCallId, command, status }];
}

/**
 * Patches the command message ACP identifies by `toolCallId`. Addressed by
 * identity for the same reason `appendChunkToMessage` is: by the time a
 * command finishes, the agent has usually said something else and the
 * command is no longer the last item.
 */
export function updateCommandMessage(
  messages: ChatMessage[],
  toolCallId: string,
  patch: { status: CommandStatus; output?: string },
): ChatMessage[] {
  return messages.map((message) =>
    message.role === "command" && message.toolCallId === toolCallId ? { ...message, ...patch } : message,
  );
}
