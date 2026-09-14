// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

/**
 * The chat sidebar's `/api/chat/stream` connection (ticket #19).
 *
 * Lifted out of App.tsx so the recovery behaviour — what happens to a turn
 * whose ending never arrives — can be tested by driving a fake
 * `EventSource`, without rendering React. Same shape as live-reload.ts:
 * callbacks in, a `stop()` out, and the `EventSource` constructor
 * injectable because jsdom (the web package's test environment) has none.
 *
 * The stream has no replay by design (see packages/server/src/sse.ts and
 * ticket #15): whatever the server pushed while nobody was connected is
 * gone for good. So a drop is not something to recover *events* from —
 * it is the end of that turn, whether or not the agent was finished. The
 * turn state is therefore reset on every `error`, including the ordinary
 * blip `EventSource` will retry on its own: even then, this turn's
 * `chat-done` has already been missed and will never arrive.
 *
 * What the author is *told* does distinguish the two, though — a brief
 * reconnect and a connection that is gone for good read differently, and
 * a blip while nothing was in flight lost nothing and says nothing.
 */
import {
  appendChunkToMessage,
  appendCommandMessage,
  appendMessage,
  appendErrorMessage, appendNoticeMessage,
  markUnfinishedCommandsInterrupted,
  updateCommandMessage,
  type ChatMessage,
  type CommandStatus,
 appendSystemMessage } from "./chat-messages.js";

export interface ChatStream {
  stop(): void;
}

export interface ChatStreamOptions {
  /** Applies a pure transform to the message list (React's setState updater form). */
  updateMessages(update: (previous: ChatMessage[]) => ChatMessage[]): void;
  setWorking(working: boolean): void;
  /** False whenever the stream cannot currently hear a reply, so sending is gated off. */
  setStreamReady(ready: boolean): void;
  /** Hands out the next stable message id. Ids are never derived from position. */
  nextMessageId(): number;
  eventSourceFactory?: (url: string) => EventSource;
}

const STREAM_PATH = "/api/chat/stream";

// The numeric value of the standard `EventSource.CLOSED` readyState (2),
// read as a plain number rather than off the `EventSource` global, which
// jsdom does not provide. CLOSED means the browser has given up for good;
// anything else means it is still retrying.
const READY_STATE_CLOSED = 2;

const RECONNECTING_NOTICE = "Connection dropped, reconnecting; the rest of this turn may have been missed";
const CLOSED_NOTICE = "Connection dropped and could not recover; the rest of this turn was not received, please refresh the page";
/** #303: shown when the author pressed Stop and the agent answered the turn with `cancelled`. */
export const STOPPED_NOTICE = "Stopped";

export function startChatStream(options: ChatStreamOptions): ChatStream {
  const createEventSource = options.eventSourceFactory ?? ((url: string) => new EventSource(url));
  const source = createEventSource(STREAM_PATH);

  // The id of the agent message the *current* turn's chunks belong to, or
  // null when no reply is in flight. A chat-chunk updates this specific
  // message by id — never "whichever message happens to be last".
  let activeReplyId: number | null = null;
  // True from the moment this turn produces anything until it reaches an
  // ending — `chat-done`, `chat-error`, or a drop. Only a turn in flight
  // can lose an ending, so this is what decides whether a drop is worth
  // telling the author about.
  let turnInFlight = false;
  // A dead connection fires `error` repeatedly; the author needs to be
  // told once, not once per retry.
  let closedNoticeShown = false;

  /**
   * Ends the current turn because the connection did, not because the
   * agent finished. Always resets the turn state: with no replay, the
   * `chat-done` for this turn is lost even if `EventSource` reconnects a
   * second later. Only the wording distinguishes a retry from a
   * connection that is gone for good — and a drop while nothing was in
   * flight lost nothing, so it says nothing.
   */
  function endTurnOnDisconnect(closedForGood: boolean): void {
    const hadSomethingToLose = turnInFlight;
    activeReplyId = null;
    turnInFlight = false;
    options.setWorking(false);

    const shouldNotify = hadSomethingToLose || (closedForGood && !closedNoticeShown);
    if (!shouldNotify) return;
    if (closedForGood) closedNoticeShown = true;

    const text = closedForGood ? CLOSED_NOTICE : RECONNECTING_NOTICE;
    options.updateMessages((previous) =>
      appendNoticeMessage(markUnfinishedCommandsInterrupted(previous), options.nextMessageId(), text),
    );
  }

  source.addEventListener("open", () => options.setStreamReady(true));

  source.addEventListener("error", () => {
    // Either kind of error means the stream cannot currently hear a
    // reply, so sending is gated off again until the next "open".
    options.setStreamReady(false);
    const closedForGood = source.readyState === READY_STATE_CLOSED;
    endTurnOnDisconnect(closedForGood);
  });

  source.addEventListener("chat-chunk", (event) => {
    const { text } = JSON.parse((event as MessageEvent).data) as { text: string };
    options.updateMessages((previous) => {
      if (activeReplyId !== null) return appendChunkToMessage(previous, activeReplyId, text);
      const id = options.nextMessageId();
      activeReplyId = id;
      return appendMessage(previous, id, "agent", text);
    });
    turnInFlight = true;
    options.setWorking(true);
  });

  // Ticket #17: the agent is about to run a command. It becomes its own
  // message in the conversation, in the order it actually happened.
  source.addEventListener("chat-command", (event) => {
    const { toolCallId, command, status, cli } = JSON.parse((event as MessageEvent).data) as {
      toolCallId: string;
      command: string;
      status: CommandStatus;
      cli?: boolean;
    };
    options.updateMessages((previous) =>
      appendCommandMessage(previous, options.nextMessageId(), toolCallId, command, status, cli ?? true),
    );
    // Whatever the agent was saying ended where the command began ("Now
    // let's edit the text:"). Anything it says after the command is a new
    // paragraph, not a continuation of the sentence the command
    // interrupted — so the next chunk starts a fresh agent message.
    activeReplyId = null;
    turnInFlight = true;
    options.setWorking(true);
  });

  source.addEventListener("chat-command-update", (event) => {
    const { toolCallId, status, output, blocked } = JSON.parse((event as MessageEvent).data) as {
      toolCallId: string;
      status: CommandStatus;
      output?: string;
      blocked?: true;
    };
    // `output` is only ever sent with a failure; passing it through as an
    // explicit `undefined` would erase output already shown. `blocked`
    // travels with it (the server sends both together or neither).
    options.updateMessages((previous) =>
      updateCommandMessage(previous, toolCallId, {
        status,
        ...(output === undefined ? {} : { output }),
        ...(blocked ? { blocked: true as const } : {}),
      }),
    );
  });

  source.addEventListener("chat-done", (event) => {
    activeReplyId = null;
    turnInFlight = false;
    options.setWorking(false);
    // #303: a turn the author stopped ends with `stopReason: "cancelled"`
    // — say so in the conversation, as a system line, so a half-finished
    // reply is not mistaken for the agent's final word. Unfinished command
    // cards are marked interrupted the same way a dropped stream marks
    // them: the command may well still be running, the outcome is simply
    // no longer reported.
    const data = (event as MessageEvent).data;
    const stopReason = typeof data === "string" && data !== "" ? (JSON.parse(data) as { stopReason?: string }).stopReason : undefined;
    if (stopReason === "cancelled") {
      options.updateMessages((previous) =>
        appendSystemMessage(markUnfinishedCommandsInterrupted(previous), options.nextMessageId(), STOPPED_NOTICE),
      );
    }
  });

  // #303: a line the server itself has to say — today only "Stop also
  // threw away N queued messages". It belongs in the conversation as a
  // system line, not in the error banner: nothing failed.
  source.addEventListener("chat-notice", (event) => {
    const { text } = JSON.parse((event as MessageEvent).data) as { text: string };
    options.updateMessages((previous) => appendSystemMessage(previous, options.nextMessageId(), text));
  });

  source.addEventListener("chat-error", (event) => {
    const { message } = JSON.parse((event as MessageEvent).data) as { message: string };
    activeReplyId = null;
    turnInFlight = false;
    options.setWorking(false);
    // In the timeline, where it happened — not a banner that outlives it.
    options.updateMessages((previous) => appendErrorMessage(previous, options.nextMessageId(), message));
  });

  return {
    stop(): void {
      source.close();
    },
  };
}
