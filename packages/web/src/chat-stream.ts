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
  appendNoticeMessage,
  markUnfinishedCommandsInterrupted,
  updateCommandMessage,
  type ChatMessage,
  type CommandStatus,
} from "./chat-messages.js";

export interface ChatStream {
  stop(): void;
}

export interface ChatStreamOptions {
  /** Applies a pure transform to the message list (React's setState updater form). */
  updateMessages(update: (previous: ChatMessage[]) => ChatMessage[]): void;
  setWorking(working: boolean): void;
  /** False whenever the stream cannot currently hear a reply, so sending is gated off. */
  setStreamReady(ready: boolean): void;
  setError(message: string): void;
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

const RECONNECTING_NOTICE = "連線中斷，正在重新連線；這一輪後續的內容可能沒有收到";
const CLOSED_NOTICE = "連線中斷且無法自動恢復；這一輪後續的內容沒有收到，請重新整理頁面";

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
    const { toolCallId, command, status } = JSON.parse((event as MessageEvent).data) as {
      toolCallId: string;
      command: string;
      status: CommandStatus;
    };
    options.updateMessages((previous) =>
      appendCommandMessage(previous, options.nextMessageId(), toolCallId, command, status),
    );
    // Whatever the agent was saying ended where the command began ("現在
    // 來修改文字："). Anything it says after the command is a new
    // paragraph, not a continuation of the sentence the command
    // interrupted — so the next chunk starts a fresh agent message.
    activeReplyId = null;
    turnInFlight = true;
    options.setWorking(true);
  });

  source.addEventListener("chat-command-update", (event) => {
    const { toolCallId, status, output } = JSON.parse((event as MessageEvent).data) as {
      toolCallId: string;
      status: CommandStatus;
      output?: string;
    };
    // `output` is only ever sent with a failure; passing it through as an
    // explicit `undefined` would erase output already shown.
    options.updateMessages((previous) =>
      updateCommandMessage(previous, toolCallId, output === undefined ? { status } : { status, output }),
    );
  });

  source.addEventListener("chat-done", () => {
    activeReplyId = null;
    turnInFlight = false;
    options.setWorking(false);
  });

  source.addEventListener("chat-error", (event) => {
    const { message } = JSON.parse((event as MessageEvent).data) as { message: string };
    activeReplyId = null;
    turnInFlight = false;
    options.setWorking(false);
    options.setError(message);
  });

  return {
    stop(): void {
      source.close();
    },
  };
}
