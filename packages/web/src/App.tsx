import { useEffect, useRef, useState } from "react";
import { mountCanvas, type CanvasController, type CanvasState } from "./canvas.js";
import { appendMessage, type ChatMessage, type CommandStatus } from "./chat-messages.js";
import { startChatStream } from "./chat-stream.js";
import { startLiveReload } from "./live-reload.js";
import { mountOverview, type OverviewController } from "./overview.js";
import { createPresentationInfoLoader, type PresentationInfo } from "./presentation.js";
import { TitleBar, type AgentConnection } from "./shell/TitleBar.js";
import { Ribbon } from "./shell/Ribbon.js";
import { Rail } from "./shell/Rail.js";
import { Stage } from "./shell/Stage.js";
import { Notes } from "./shell/Notes.js";
import { StatusBar } from "./shell/StatusBar.js";
import { PlayChrome } from "./shell/PlayChrome.js";
import type { ShellView } from "./shell/view.js";

/**
 * WebKit still ships only the prefixed `webkitExitFullscreen` (matching
 * e2e/fullscreen-spike.test.ts). Shared by toggleFullscreen() and
 * handleExitPlay() below rather than duplicated — exitFullscreen() needs no
 * transient activation, unlike requestFullscreen(), so it is safe to call
 * from either place without a fresh click.
 */
function exitFullscreenIfActive(): Promise<void> {
  const doc = document as Document & { webkitExitFullscreen?: () => Promise<void> };
  const exit = doc.exitFullscreen ?? doc.webkitExitFullscreen;
  return exit ? exit.call(doc) : Promise.resolve();
}

/**
 * Reads the browser's own fullscreen state directly — never the React
 * `isFullscreen` state, which can be stale while a requestFullscreen() call
 * is still pending (review gate round 2, P2: 離開播放 clicked while a
 * request was in flight used to trust the not-yet-updated React state,
 * skip exiting fullscreen, and leave the document genuinely stuck
 * fullscreen once the pending request settled after play mode's chrome was
 * already gone). Shared by the fullscreenchange listener and
 * handleExitPlay() so both ask the same real question the same way.
 */
function isCanvasAreaFullscreen(container: Element | null): boolean {
  const doc = document as Document & { webkitFullscreenElement?: Element | null };
  const fullscreenElement = doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
  return fullscreenElement !== null && fullscreenElement === container;
}

/**
 * React owns the shell only (`shell/*.tsx`, ticket #48/#51/#52/#53) — the
 * canvas/overview containers below are handed to the vanilla `mountCanvas`/
 * `mountOverview` modules exactly once; React never re-renders into them
 * again (ADR-0001, ADR-0002). `<Stage>`'s position in the tree is fixed:
 * only its siblings are ever conditionally rendered (play mode hides the
 * rest of the shell), so `canvasRef`'s DOM node identity survives every
 * mode switch — see the comment on `wellRef` below for why that matters.
 */
export function App() {
  const canvasRef = useRef<HTMLDivElement | null>(null);
  // 全螢幕開關 (ticket #29 第二輪, revised for #48/#51's ruling on §0.2 item 2):
  // the fullscreen target is `.canvas-area` — the stage floor — reused in
  // BOTH 檢視模式 (the ribbon's 全螢幕 button) and 播放模式 (PlayChrome's own
  // button). It already contains the iframe (via canvasRef) and every
  // play-mode notice/PlayChrome (rendered as Stage's children), and it
  // already excludes the rail/notes/chat siblings. A real click cannot
  // reach anything outside the fullscreen element once the browser puts it
  // in the top layer (measured while building ticket #29 — see its final
  // report), so PlayChrome must render inside this same element.
  const wellRef = useRef<HTMLDivElement | null>(null);
  const overviewRef = useRef<HTMLElement | null>(null);
  const overviewControllerRef = useRef<OverviewController | null>(null);
  // The canvas module owns the selected slide (ADR-0001/ADR-0002); React
  // only mirrors it here so the paging chrome can render, and issues
  // commands back through the controller.
  const controllerRef = useRef<CanvasController | null>(null);
  const [canvasState, setCanvasState] = useState<CanvasState>({
    slides: [],
    currentIndex: -1,
    mode: "view",
    playerHasFocus: false,
    error: null,
    selection: null,
  });
  // Ticket #5 fix round: a dead watcher used to fail silently — the SSE
  // stream closed, EventSource retried forever against a server that would
  // only ever refuse, and the author never saw anything. `startLiveReload`'s
  // `onError` now closes that loop; this state is what actually puts the
  // message on screen instead of leaving it as an unhandled event.
  const [liveReloadError, setLiveReloadError] = useState<string | null>(null);

  // #51's titlebar: the deck's name and canvas size, fetched separately
  // from canvas.ts's own CanvasState (which deliberately carries only
  // slides/currentIndex/mode/playerHasFocus/error — #29/#30 build against
  // that exact contract). A failed or invalid response is never papered
  // over with a fabricated name/size — see presentation.ts.
  const [presentationInfo, setPresentationInfo] = useState<PresentationInfo | null>(null);
  const [presentationError, setPresentationError] = useState<string | null>(null);
  // Race guard against overlapping loads (e.g. two rapid live-reload
  // presentation-changed events) lives inside the loader itself — see
  // presentation.ts's createPresentationInfoLoader for the full comment.
  // One loader instance for the component's whole lifetime (created lazily
  // via a ref, not on every render) so its internal generation counter
  // stays continuous across every load() call.
  const presentationLoaderRef = useRef<ReturnType<typeof createPresentationInfoLoader> | null>(null);
  if (!presentationLoaderRef.current) {
    presentationLoaderRef.current = createPresentationInfoLoader({
      onSuccess: (info) => {
        setPresentationInfo(info);
        setPresentationError(null);
      },
      onError: (message) => {
        setPresentationInfo(null);
        setPresentationError(message);
      },
    });
  }

  // #55's reserved seam: the centre column's own view (normal/grid),
  // orthogonal to canvasState.mode (view/play). "grid" is not reachable
  // yet — no button sets it — but Stage/Notes already accept it so #55 can
  // land its own button and its own Stage branch without reopening this
  // file.
  const [view, setView] = useState<ShellView>("normal");

  // #51's connection indicator: derived from the one real signal this app
  // has (chat-stream.ts's streamReady), never a fabricated vendor label —
  // see the PR body for the server-side gap this leaves (adapter label /
  // real ACP session state need a new server route, out of this unit's
  // file ownership).
  const [agentConnection, setAgentConnection] = useState<AgentConnection>("connecting");
  const everConnectedRef = useRef(false);

  // 全螢幕開關 (ticket #29): mirrors document.fullscreenElement, never
  // assumed from "the promise resolved". Synced only from fullscreenchange
  // (+ the WebKit-prefixed spelling) so Esc, browser chrome, and the toggle
  // button all funnel through one place.
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [fullscreenError, setFullscreenError] = useState<string | null>(null);
  // Tracks an in-flight requestFullscreen()/exitFullscreen() call so
  // handleExitPlay() can wait for it to settle before asking the browser's
  // real fullscreenElement — see isCanvasAreaFullscreen()'s comment above
  // for the race this closes (review gate round 2, P2).
  const fullscreenRequestRef = useRef<Promise<void> | null>(null);

  useEffect(() => {
    const container = canvasRef.current;
    if (!container) return;
    const controller = mountCanvas(container);
    controllerRef.current = controller;
    const unsubscribe = controller.subscribe(setCanvasState);
    // Live reload (ticket #5): the server pushes a `presentation-changed`
    // event over /api/events whenever a slide is modified externally;
    // reload() re-fetches and redraws without React re-rendering anything.
    // Stopped on cleanup — a live EventSource surviving unmount would leak
    // a connection per React StrictMode double-mount.
    const liveReload = startLiveReload({
      onChange: () => {
        void controller.reload();
        // 總覽 (ticket #27, P1 fix): an external edit can change a slide's
        // markup without project.json's `slides` list moving at all —
        // canvas.subscribe() can't tell that apart from a plain index
        // change, so the overview needs telling explicitly here.
        overviewControllerRef.current?.refresh();
        // #51: an external edit can rename the deck or resize its canvas
        // too — re-fetch the same way overview.ts's own refresh() re-reads
        // the aspect ratio.
        presentationLoaderRef.current?.load();
      },
      onError: setLiveReloadError,
    });
    presentationLoaderRef.current?.load();
    return () => {
      liveReload.stop();
      unsubscribe();
      controller.destroy();
      controllerRef.current = null;
    };
  }, []);

  // 總覽 (ticket #27): mounted once against the canvas controller — it
  // subscribes on its own and needs no React state mirrored back here.
  //
  // #54 (wave 4) now unmounts `<Rail>` entirely in 播放模式 (see the
  // shellVisible-gated render below), which destroys `overviewRef`'s DOM
  // node. A `[]` dependency array here would only ever run this effect
  // once at the component's very first mount: on returning to 檢視模式,
  // `<Rail>` remounts with a *fresh* container, `overviewRef.current`
  // points at it, but this effect never fires again to mount anything
  // into it — the overview module never comes back, with nothing thrown
  // (the exact hazard the wave brief calls out). Keying the effect on
  // `canvasState.mode !== "play"` makes it re-run each time `<Rail>`
  // unmounts/remounts: React attaches refs before effects run, so by the
  // time this body executes after a remount, `overviewRef.current` already
  // points at the new container. While play mode is active the container
  // is null (Rail is absent) and the effect body simply skips mounting
  // anything, matching `<Rail>` being absent from the DOM.
  useEffect(() => {
    const container = overviewRef.current;
    const controller = controllerRef.current;
    if (!container || !controller) return;
    const overview = mountOverview(container, controller);
    overviewControllerRef.current = overview;
    return () => {
      overview.destroy();
      overviewControllerRef.current = null;
    };
  }, [canvasState.mode !== "play"]);

  // Arrow keys in 檢視模式 page the deck (ticket #28). Legitimate on the
  // parent document: the view-mode iframe is sandboxed with no scripts, so
  // the author's keystrokes never reach it.
  //
  // In 播放模式 the keyboard belongs to the runtime inside the play iframe,
  // and this handler must not fight it — if both reacted to the same
  // ArrowRight, one key press would advance two steps. What keeps them
  // apart is not a state check but the event model itself: a key press is
  // dispatched in exactly one document, and keyboard events do not cross
  // the frame boundary. So this listener running at all is already proof
  // that the runtime did not hear this key.
  //
  // It must NOT be gated on `playerHasFocus` instead. That flag arrives
  // over postMessage and lands in React state, so it lags the browser's
  // real focus: right after entering play or changing slide there is a
  // window where focus is genuinely inside the iframe while the flag still
  // reads false. Forwarding during that window is the double-advance this
  // paragraph is about — the runtime handles the key press *and* the
  // parent posts another step. That is not theoretical: it is what an
  // earlier revision of this handler did, and e2e/demo-deck.test.ts caught
  // it (the deck ran ahead of where the test thought it was, and the 2s
  // demo video had finished playing by the time the audio step was
  // reached).
  //
  // The parent takes over only in the case the runtime cannot serve: focus
  // sat outside the iframe, so no keydown reached the runtime at all and
  // the deck would otherwise be stuck until the author fixed the focus by
  // hand — with the mouse, since the keyboard was exactly what stopped
  // working. One press of Tab is enough to get there (measured, #68);
  // clicking the control bar is not, because every one of those paths
  // already hands focus back (the ready handshake after a slide change,
  // settled decision #5's focusPlayer() on the fullscreen paths, and
  // .play-mousemove-catcher's own onClick).
  //
  // Known limit, deliberate: postMessage does not carry this key press's
  // transient activation into a sandboxed, non-same-origin frame, so if
  // the forwarded step happens to be a media effect, the browser refuses
  // its play(). It is not silent — player-runtime.js's playMedia posts a
  // visible error — and focusPlayer() below means it can only ever be the
  // first key press after focus was lost, never a steady state.
  //
  // A slide whose effect list failed to parse has no runtime at all to
  // forward to (canvas.ts's renderPlay catch swaps in a static document),
  // so the arrow keys stay inert there — unchanged by this, and already
  // answered by #54's 上一步/下一步 buttons, which page the deck without
  // needing a runtime.
  //
  // `canvasStateRef` (not `canvasState` itself) is read inside the
  // listener so this effect never needs to re-subscribe on every state
  // change just to see the current mode.
  const canvasStateRef = useRef(canvasState);
  canvasStateRef.current = canvasState;
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      // Never steal an arrow key from a text field — the author is moving
      // the caret in the chat box, not paging the deck.
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      const controller = controllerRef.current;
      if (!controller) return;
      const state = canvasStateRef.current;
      if (state.mode === "play") {
        event.preventDefault();
        controller.stepPlayer(event.key === "ArrowRight" ? "advance" : "retreat");
        // Hand focus back so every following key press takes the runtime's
        // own path, transient activation and all.
        controller.focusPlayer();
        return;
      }
      event.preventDefault();
      void (event.key === "ArrowRight" ? controller.next() : controller.previous());
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  // 全螢幕開關 (ticket #29): fullscreenchange only syncs UI state here — it
  // must never call exitPlay(). Leaving fullscreen (including Esc) returns
  // to 內嵌播放, not out of 播放模式 (design doc's 全螢幕 section: 全螢幕不是
  // 另一種模式). Registers both the unprefixed and WebKit-prefixed event
  // names, matching e2e/fullscreen-spike.test.ts.
  useEffect(() => {
    function onFullscreenChange(): void {
      setIsFullscreen(isCanvasAreaFullscreen(wellRef.current));
      // This event firing at all means the browser's real fullscreen state
      // just genuinely changed — by Esc, by browser chrome, or by our own
      // button — which makes any earlier "a fullscreen request failed"
      // message stale no matter how it got there (review gate round 1, P2:
      // a stale fullscreenError used to sit on screen after a later,
      // successful exit/enter until the next click cleared it by hand).
      setFullscreenError(null);
      // Every fullscreen transition must hand focus back to the player, or
      // arrow-key advance silently dies (settled decision #5). A no-op
      // outside 播放模式 (focusPlayer() itself gates on mode === "play").
      controllerRef.current?.focusPlayer();
    }
    document.addEventListener("fullscreenchange", onFullscreenChange);
    document.addEventListener("webkitfullscreenchange", onFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      document.removeEventListener("webkitfullscreenchange", onFullscreenChange);
    };
  }, []);

  // Leaving 播放模式 by any route (離開播放 button, live reload emptying the
  // deck, ...) must not leave stale fullscreen UI state behind even though
  // handleExitPlay() below already asks the document to exit fullscreen.
  useEffect(() => {
    if (canvasState.mode !== "play") {
      setIsFullscreen(false);
      setFullscreenError(null);
    }
  }, [canvasState.mode]);

  async function toggleFullscreen(): Promise<void> {
    setFullscreenError(null);
    if (isFullscreen) {
      const exitPromise = exitFullscreenIfActive();
      fullscreenRequestRef.current = exitPromise;
      try {
        await exitPromise;
      } catch (error) {
        // Surfaced, never swallowed (behaviour contract row 1).
        setFullscreenError(error instanceof Error ? error.message : "退出全螢幕失敗");
      } finally {
        if (fullscreenRequestRef.current === exitPromise) fullscreenRequestRef.current = null;
      }
      controllerRef.current?.focusPlayer();
      return;
    }
    // The stage floor, not the iframe (frameElement) — see the ref comment
    // above. Read fresh at call time regardless: React refs are stable
    // across renders here, but this keeps the same discipline as
    // frameElement's own "never cache" rule.
    const container = wellRef.current;
    if (!container) return;
    const webkitContainer = container as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> };
    const request = (container.requestFullscreen ?? webkitContainer.webkitRequestFullscreen)?.bind(container);
    if (!request) {
      setFullscreenError("這個瀏覽器不支援全螢幕");
      // P2 (review gate round 2): this early-return path used to skip
      // focusPlayer() — the click that got here already moved DOM focus
      // onto this button, so without this call the arrow keys silently die
      // just like every other fullscreen transition would if it skipped
      // this (settled decision #5 applies here too, not just the two paths
      // that actually touch the Fullscreen API).
      controllerRef.current?.focusPlayer();
      return;
    }
    // A real click (this function is only ever called from an onClick
    // handler) carries the transient activation requestFullscreen() needs;
    // never fabricate a fullscreen UI state the promise did not actually
    // grant (behaviour contract row 1). Declared before the try block (not
    // inside it) so the finally below — a separate block scope — can still
    // see this specific call's own promise to compare against.
    const requestPromise = request();
    fullscreenRequestRef.current = requestPromise;
    try {
      await requestPromise;
    } catch (error) {
      setFullscreenError(error instanceof Error ? error.message : "進入全螢幕失敗");
    } finally {
      // Only clear the ref if it still points at *this* call's own promise
      // (same guard the exit branch above already uses). Two clicks in
      // quick succession each capture their own promise in this closure;
      // an unconditional clear here would let an earlier call's `finally`
      // wipe out a later, still in-flight call's promise the moment the
      // earlier one settles — handleExitPlay() would then have nothing to
      // await for the request that is actually still pending (review gate
      // round 3, P2).
      if (fullscreenRequestRef.current === requestPromise) fullscreenRequestRef.current = null;
    }
    controllerRef.current?.focusPlayer();
  }

  async function handleExitPlay(): Promise<void> {
    // 離開播放時若還在全螢幕，必須先退出全螢幕，否則文件會卡在全螢幕狀態
    // 但畫面底下已經沒有播放器了（behaviour contract 表格第四列）。A
    // requestFullscreen() call started just before this click can still be
    // pending here — isFullscreen (React state) has not been updated yet,
    // so trusting it would skip exiting, and the pending request would
    // still land after play mode's chrome (including 退出全螢幕) is already
    // gone, leaving the document genuinely stuck fullscreen (review gate
    // round 2, P2). Wait for any in-flight request to settle first, then
    // ask the browser's own fullscreenElement — not the stale React state
    // — right before deciding.
    if (fullscreenRequestRef.current) {
      try {
        await fullscreenRequestRef.current;
      } catch {
        // A rejected request needs no exit.
      }
    }
    if (isCanvasAreaFullscreen(wellRef.current)) {
      try {
        await exitFullscreenIfActive();
      } catch {
        // Ignored on purpose — exiting play mode must proceed either way, a
        // stuck fullscreen toggle should not also trap the author in play
        // mode.
      }
    }
    await controllerRef.current?.exitPlay();
  }

  const hasSlides = canvasState.slides.length > 0;

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // True once the EventSource connection is open and can actually receive
  // a reply. A message sent while this is false (initial connect, or
  // mid-reconnect after a drop) would be answered with no listener
  // attached — the SSE primitive keeps no history to replay, so the
  // client must know it can hear before it speaks (fix 5).
  const [streamReady, setStreamReady] = useState(false);
  // Every message gets a stable id at creation, handed out from this
  // counter — never derived from array position. A ref, not state: it is
  // read and written from both the SSE listeners and sendMessage, and
  // must never itself trigger a re-render.
  const nextMessageIdRef = useRef(0);

  useEffect(() => {
    // All of the turn bookkeeping — including what happens to a turn whose
    // ending is lost to a dropped connection — lives in chat-stream.ts so
    // it can be tested without rendering React (ticket #19).
    const stream = startChatStream({
      updateMessages: setMessages,
      setWorking,
      setStreamReady,
      setError,
      nextMessageId: () => nextMessageIdRef.current++,
    });
    return () => stream.stop();
  }, []);

  // #51's connection indicator: three states derived purely from
  // streamReady, never a vendor label this app cannot honestly claim (see
  // the comment on the state above).
  useEffect(() => {
    if (streamReady) {
      everConnectedRef.current = true;
      setAgentConnection("connected");
    } else if (everConnectedRef.current) {
      setAgentConnection("disconnected");
    }
  }, [streamReady]);

  async function sendMessage(): Promise<void> {
    const text = draft.trim();
    if (!text) return;
    if (!streamReady) {
      // Honest refusal, not a silent drop or a silent queue: the author
      // can see the chat is not ready yet instead of losing the message
      // with no trace.
      setError("聊天連線尚未就緒，請稍候再試一次");
      return;
    }
    const id = nextMessageIdRef.current++;
    setMessages((prev) => appendMessage(prev, id, "author", text));
    setDraft("");
    setError(null);
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? "傳送訊息失敗");
      }
    } catch {
      // `fetch` rejects (rather than resolving with a non-OK response) when
      // the connection drops entirely — e.g. the server going away between
      // `streamReady` and this call. The draft is already cleared and the
      // message already rendered above by this point, so without this catch
      // the author would see their message sitting in the conversation as
      // if it had been delivered, when it was not — fabricating success is
      // forbidden here. Reuses the same `error` state the non-OK branch
      // above uses, naming the message so it is clear which one failed.
      setError(`「${text}」傳送失敗：連線已中斷，此訊息尚未送出`);
    }
  }

  const shellVisible = canvasState.mode !== "play";

  return (
    <div className="app" data-mode={canvasState.mode}>
      {shellVisible && (
        <TitleBar
          deckName={presentationInfo?.name ?? null}
          canvasSize={presentationInfo?.canvas ?? null}
          agentConnection={agentConnection}
        />
      )}
      {shellVisible && (
        <Ribbon
          onPlayFromStart={() => {
            void (async () => {
              await controllerRef.current?.showSlide(0);
              await controllerRef.current?.play();
            })();
          }}
          onPlayFromCurrent={() => void controllerRef.current?.play()}
          onToggleFullscreen={() => void toggleFullscreen()}
          canPlay={hasSlides}
        />
      )}
      {shellVisible && liveReloadError && (
        <div role="alert" className="live-reload-banner">
          即時預覽已停止：{liveReloadError}，請重新整理頁面
        </div>
      )}
      {shellVisible && presentationError && (
        <div role="alert" className="live-reload-banner">
          簡報資訊載入失敗：{presentationError}
        </div>
      )}
      <div className="body">
        {/* #54 (wave 4): now absent from the DOM in 播放模式, unlike the
            wave-2/wave-3 posture recorded in the comment this replaces.
            That older comment's constraint — e2e/player-effect-error.test.ts
            and e2e/player-media.test.ts clicking overview thumbnails
            (button[aria-label="第 N 頁"]) *during* play mode as their only
            way to change slides when a broken effect list leaves no
            runtime alive to hear arrow keys — has been migrated onto
            #54's own play-bar 上一步/下一步 buttons (controller.previous()/
            next()), which work the same way with no runtime required. The
            overview module's mount/unmount survives this: see the
            overview-mounting effect's own comment above. */}
        {shellVisible && <Rail containerRef={overviewRef} />}
        <div className="main">
          <Stage
            canvasRef={canvasRef}
            wellRef={wellRef}
            canvasSize={presentationInfo?.canvas ?? null}
            state={canvasState}
            controller={controllerRef.current}
            view={view}
            onViewChange={setView}
          >
            <PlayChrome
              state={canvasState}
              controller={controllerRef.current}
              isFullscreen={isFullscreen}
              fullscreenError={fullscreenError}
              onToggleFullscreen={() => void toggleFullscreen()}
              onExitPlay={() => void handleExitPlay()}
            />
          </Stage>
          {shellVisible && <Notes hidden={view === "grid"} />}
        </div>
        {/* #54 (wave 4): now absent from the DOM in 播放模式 — #54's own
            AC ("功能區、縮圖軌、對話、備忘稿、狀態列都不在 DOM 裡") names
            對話 explicitly. No e2e test depends on the chat sidebar being
            present during play mode (unlike <Rail>, which needed the
            5-site migration above before it could be gated the same way). */}
        {shellVisible && (
          <aside className="chat-sidebar">
            <h2>對話</h2>
            <div className="chat-messages">
              {messages.length === 0 && <p className="chat-placeholder">跟 agent 說說你想怎麼改這份簡報</p>}
              {messages.map((message) =>
                message.role === "notice" ? (
                  <p key={message.id} className="chat-notice" role="alert">
                    {message.text}
                  </p>
                ) : message.role === "command" ? (
                  <div
                    key={message.id}
                    className={`chat-command chat-command-${message.interrupted ? "interrupted" : message.status}`}
                    role={message.status === "failed" ? "alert" : undefined}
                  >
                    <p className="chat-command-line">
                      <span className="chat-command-status">
                        {message.interrupted ? COMMAND_INTERRUPTED_LABEL : COMMAND_STATUS_LABEL[message.status]}
                      </span>
                      <code className="chat-command-text">{message.command}</code>
                    </p>
                    {message.output !== undefined && <pre className="chat-command-output">{message.output}</pre>}
                  </div>
                ) : (
                  <p key={message.id} className={`chat-message chat-message-${message.role}`}>
                    {message.text}
                  </p>
                ),
              )}
              {working && <p className="chat-working">agent 正在工作中…</p>}
              {!streamReady && <p className="chat-connecting">聊天連線建立中…</p>}
              {error && <p className="chat-error">{error}</p>}
            </div>
            <form
              className="chat-input"
              onSubmit={(event) => {
                event.preventDefault();
                void sendMessage();
              }}
            >
              <input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder={streamReady ? "輸入訊息給 agent…" : "聊天連線建立中，請稍候…"}
              />
              <button type="submit" disabled={!streamReady}>
                送出
              </button>
            </form>
          </aside>
        )}
      </div>
      {shellVisible && (
        <StatusBar
          state={canvasState}
          controller={controllerRef.current}
          view={view}
          onViewChange={setView}
          onExitPlay={() => void handleExitPlay()}
        />
      )}
    </div>
  );
}

/**
 * What each ACP tool-call status means to the author. The status itself
 * stays ACP's own string all the way from the agent to here — this map is
 * the single place it becomes something a person reads.
 */
/**
 * Shown instead of the status label when the stream died before the
 * command's outcome arrived (ticket #19). Not a `CommandStatus` value: we
 * do not know whether it worked, and "執行失敗" would be a made-up answer
 * to a question nobody ever answered.
 */
const COMMAND_INTERRUPTED_LABEL = "結果不明";

const COMMAND_STATUS_LABEL: Record<CommandStatus, string> = {
  pending: "準備執行",
  in_progress: "執行中",
  completed: "已完成",
  failed: "執行失敗",
};
