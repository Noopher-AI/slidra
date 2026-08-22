/**
 * Pure message-list operations for the chat sidebar (ticket #6, fix 3).
 *
 * Kept separate from App.tsx so the identity fix — a `chat-chunk` updates
 * the specific agent message it belongs to, never "whatever is last" —
 * is testable without rendering React.
 */
export interface ChatMessage {
  /** Stable identity, assigned once at creation. Never recomputed from position. */
  id: number;
  role: "author" | "agent";
  text: string;
}

/** Appends a brand-new message (author or agent) with the given id. */
export function appendMessage(
  messages: ChatMessage[],
  id: number,
  role: ChatMessage["role"],
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
  return messages.map((message) => (message.id === id ? { ...message, text: message.text + text } : message));
}
