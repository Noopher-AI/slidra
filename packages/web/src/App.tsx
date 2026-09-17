// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { useEffect, useRef, useState, type DragEvent } from "react";
import {
  fromAgentResponse,
  modelOptionsFrom,
  type AgentConnection,
  type AgentModelOption,
  type AgentUiStatus,
  turnRunningFrom,
  writeIsolationFrom,
  type WriteIsolationView,
} from "./agent-status.js";
import { mountCanvas, type CanvasController, type CanvasState, type ImportedAsset } from "./canvas.js";
import { appendMessage, restoreChatMessages, type ChatMessage, type PersistedChatEntry, appendErrorMessage } from "./chat-messages.js";
import { startChatStream, type ChatStream } from "./chat-stream.js";
import { startLiveReload, type AgentKind, type ExportFormat, type ExportSseEvent, type SaveState } from "./live-reload.js";
import type { SlashCommandOption } from "./slash-commands.js";
import { mountOverview, type OverviewController } from "./overview.js";
import { fetchDeckComments, sortComments, type NumberedComment } from "./comments.js";
import { createPresentationInfoLoader, type PresentationInfo } from "./presentation.js";
import { TitleBar } from "./shell/TitleBar.js";
import { renameCurrentDeck } from "./shell/deck-space/deck-api.js";
import { installUnsavedGuard } from "./unsaved-guard.js";
import { Rail, type ThumbContextMenuRequest } from "./shell/Rail.js";
import type { ExportUiState } from "./shell/ExportPanel.js";
import { Stage } from "./shell/Stage.js";
import { Notes } from "./shell/Notes.js";
import { StatusBar } from "./shell/StatusBar.js";
import { SidePanel, type SideId, type SubId } from "./shell/side/SidePanel.js";
import { ChatPanel } from "./shell/side/ChatPanel.js";
import { PlayChrome } from "./shell/PlayChrome.js";
import { PlanGateModal } from "./shell/PlanGateModal.js";
import { parsePlanOutline, type PlanOutline } from "./plan-file.js";
import { mediaInsertInput } from "./shell/dock/panels/media-insert.js";
import { buildApplyMasterMessage } from "./shell/master-mode/master-prompt.js";
import type { UserBlockProps } from "./shell/user-block/UserBlock.js";

/**
 * WebKit still ships only the prefixed `webkitExitFullscreen`. Shared by
 * toggleFullscreen() and
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
 * is still pending ("Exit play" clicked while a
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

/** Maps one `export` SSE event onto the dropdown's own UI state (§4.7). `queued` has no frame counts yet — ExportPanel already treats `totalFrames === 0` as "still starting" and shows a bare "Exporting…". Exported so tests can cover this event→props conversion directly — component tests alone only exercise ExportPanel(props) → markup, which stays green even if this function's wiring is broken. */
export function toExportUiState(event: ExportSseEvent): ExportUiState {
  switch (event.state) {
    case "queued":
      return { kind: "busy", format: event.format, completedFrames: 0, totalFrames: 0 };
    case "running":
    case "progress":
      return { kind: "busy", format: event.format, completedFrames: event.completedFrames, totalFrames: event.totalFrames };
    case "done":
      return { kind: "done", fileName: event.fileName, pageCount: event.pageCount, downloadPath: event.downloadPath };
    case "error":
      return { kind: "error", message: event.message };
  }
}

export interface AppProps {
  /** [E6.T4]: `TitleBar`'s "Deck Space" button — `Workspace.tsx` is the one place that decides what opening it means (an overlay above this editor). */
  onOpenDeckSpace(): void;
  /**
   * True while Deck Space is showing as an overlay above this editor.
   * [E6.T4] plan §7 decision 8: the window `dragenter` guard below must
   * ignore a file drag while it's open (Deck Space owns its own drop zone
   * instead), and the drop overlay must be forced closed the instant it
   * opens — otherwise closing Deck Space again can leave the stage tinted
   * forever from a drag that started while it was up.
   */
  deckSpaceOpen: boolean;
  /** [E6.T14r2] Plan §7 decision 4: identity state now lives in `Workspace.tsx` (no deck bound means `<App>` never mounts at all, yet Deck Space still needs the same block) — `<Rail>`'s bottom mount gets these props straight through, `useIdentity()` is never called here. */
  userBlock: UserBlockProps;
}

/**
 * React owns the shell only (`shell/*.tsx`) — the
 * canvas/overview containers below are handed to the vanilla `mountCanvas`/
 * `mountOverview` modules exactly once; React never re-renders into them
 * again (ADR-0001, ADR-0002). `<Stage>`'s position in the tree is fixed:
 * only its siblings are ever conditionally rendered (play mode hides the
 * rest of the shell), so `canvasRef`'s DOM node identity survives every
 * mode switch — see the comment on `wellRef` below for why that matters.
 */
export function App({ onOpenDeckSpace, deckSpaceOpen, userBlock }: AppProps) {
  const canvasRef = useRef<HTMLDivElement | null>(null);
  // Fullscreen toggle (per §0.2 item 2's ruling):
  // the fullscreen target is `.canvas-area` — the stage floor — reused in
  // BOTH view mode (the ribbon's fullscreen button) and play mode (PlayChrome's own
  // button). It already contains the iframe (via canvasRef) and every
  // play-mode notice/PlayChrome (rendered as Stage's children), and it
  // already excludes the rail/notes/chat siblings. A real click cannot
  // reach anything outside the fullscreen element once the browser puts it
  // in the top layer, so PlayChrome must render inside this same element.
  const wellRef = useRef<HTMLDivElement | null>(null);
  const overviewRef = useRef<HTMLElement | null>(null);
  const overviewControllerRef = useRef<OverviewController | null>(null);
  // [E2.T3]: overview.ts's own contextmenu handler (a vanilla DOM module)
  // has no React tree of its own to render a menu into, so it reports the
  // index + cursor position up through this state instead; `<Rail>` renders
  // the actual `<ThumbContextMenu>`.
  const [contextMenuRequest, setContextMenuRequest] = useState<ThumbContextMenuRequest | null>(null);
  // The deck-wide comment list, sorted/numbered (comments.ts's
  // sortComments) — reloaded on mount and on every presentation-changed
  // event (an agent's own `comment add`/`edit`/`delete` reaches here the
  // same way a GUI-originated write does, both go through the same file).
  const [comments, setComments] = useState<NumberedComment[]>([]);
  // The plan-confirmation gate's input — `plan/outline.md`'s parsed
  // head, reloaded on mount and on every presentation-changed event the
  // same way `comments` is (the agent's `plan set` is just another file
  // write under the work dir, which changes.ts's recursive watcher
  // already reports). `null` = no plan file, or one the parser rejected.
  const [planOutline, setPlanOutline] = useState<PlanOutline | null>(null);
  // The fence text of the draft the author last answered. The agent only
  // rewrites the file (as `confirmed`, or as a new draft) some time after
  // "Confirm"/"Redo" is sent, so the very same draft would re-open the gate on the
  // next unrelated presentation-changed event without this. A *different*
  // draft (new fence text) is a new question and does re-open it.
  const [answeredPlanFence, setAnsweredPlanFence] = useState<string | null>(null);
  // Read inside handlers registered from an effect that doesn't re-run on
  // every render (the overview-mount effect below, keyed on play-mode
  // only) — same "latest ref" reasoning as `canvasStateRef`'s own comment.
  const commentsRef = useRef(comments);
  commentsRef.current = comments;
  // The open composer's own state: `target` is `null` while closed, an
  // element id or the literal "page" while open. `draft`/`editingCommentId`
  // are separate from `comments` above — an in-progress edit must survive
  // a comment-list reload triggered by an unrelated write elsewhere in the
  // deck (§4.7 of the plan never says a reload should discard a draft).
  const [commentComposerTarget, setCommentComposerTarget] = useState<string | null>(null);
  const [commentEditingId, setCommentEditingId] = useState<string | null>(null);
  const [commentDraft, setCommentDraft] = useState("");
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
    selection: { ids: [], names: [], groupPath: [], elements: [] },
    dragSignal: 0,
    pageStyle: null,
    backgroundImage: null,
    pageSource: "slides",
  });
  // Ticket #5 fix round: a dead watcher used to fail silently — the SSE
  // stream closed, EventSource retried forever against a server that would
  // only ever refuse, and the author never saw anything. `startLiveReload`'s
  // `onError` now closes that loop; this state is what actually puts the
  // message on screen instead of leaving it as an unhandled event.
  const [liveReloadError, setLiveReloadError] = useState<string | null>(null);
  // T5 (NOOP-93/#110): true while the agent's current turn holds the
  // single-editor lock. `/api/events` carries no replay (same as every
  // other event on this stream), so the *initial* value on mount/reconnect
  // must come from `GET /api/editing`, not from a stream event — see the
  // effect below.
  const [editingFrozen, setEditingFrozen] = useState(false);

  // NOOP-422: the titlebar's Saved/Saving…/Save failed story. `known:false`
  // (the initial value) means "no opinion yet" — same as a pre-NOOP-93
  // registry entry — so the titlebar falls back to `presentationInfo`'s
  // name and shows no status text (§4(c)'s table) until the first
  // `GET /api/save-state` in the mount effect below resolves.
  const [saveState, setSaveState] = useState<SaveState>({ known: false });
  const [openError, setOpenError] = useState<string | null>(null);

  // [E3.T3] #232/#236: the `/` command list — agent report ∪ bundled
  // skills ∪ user skills (architecture decision on #232/#236 — not a
  // fallback, all three are standing sources). `[]` means "nothing
  // reported/found yet", same meaning `GET /api/agent/commands` gives an
  // agent that has never reported and two empty/missing skill
  // directories — SlashMenu shows the fixed hint text for that case.
  const [commands, setCommands] = useState<SlashCommandOption[]>([]);

  // NOOP-93 §4.7: the Export dropdown's own open/closed state, and the
  // job UI state derived from `export` SSE events (or set directly by
  // handleExportPick for the 202/409 response itself, which arrives before
  // any SSE event for a brand-new job could). No GET counterpart seeds this
  // on mount/reconnect — §4.7's table says a reload loses in-flight
  // progress on purpose.
  const [exportOpen, setExportOpen] = useState(false);
  const [exportState, setExportState] = useState<ExportUiState>({ kind: "idle" });

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

  // #51's connection indicator: derived from the one real signal this app
  // has (chat-stream.ts's streamReady), never a fabricated vendor label —
  // see the PR body for the server-side gap this leaves (adapter label /
  // real ACP session state need a new server route, out of this unit's
  // file ownership).
  const [agentConnection, setAgentConnection] = useState<AgentConnection>("connecting");
  const everConnectedRef = useRef(false);

  // [E3.T5] NOOP-230/#234: the settings dialog's agent tab drives off this
  // one piece of state — `GET /api/agent` seeds it, `POST /api/agent/probe`
  // and a successful `POST /api/agent/select` both refresh it via the same
  // `refreshAgentStatus()` (below), and `agent-changed` SSE events do too
  // (the mount effect's `onAgentChanged`). `loading` is this state's own
  // initial value; `fromAgentResponse` itself never produces it.
  const [agentStatus, setAgentStatus] = useState<AgentUiStatus>({ kind: "loading" });
  // True while a GET /api/agent or POST /api/agent/probe is in flight
  // (Plan §4.4 row 1 — deliberately covers both, not just the probe POST).
  const [agentProbing, setAgentProbing] = useState(false);
  // The card mid-POST /api/agent/select ("Switching…", Plan §4.5), and that
  // request's own error strip (409 editing / 400 / 500 / network).
  const [agentSwitchingKind, setAgentSwitchingKind] = useState<AgentKind | null>(null);
  const [agentActionError, setAgentActionError] = useState<string | null>(null);
  // The list of models that can be switched to, plus the current id, also from `GET /api/agent`; an empty list means nothing to pick.
  const [agentModelOptions, setAgentModelOptions] = useState<readonly AgentModelOption[]>([]);
  const [agentModelId, setAgentModelId] = useState<string | null>(null);
  // Fullscreen toggle: mirrors document.fullscreenElement, never
  // assumed from "the promise resolved". Synced only from fullscreenchange
  // (+ the WebKit-prefixed spelling) so Esc, browser chrome, and the toggle
  // button all funnel through one place.
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [fullscreenError, setFullscreenError] = useState<string | null>(null);
  // Tracks an in-flight requestFullscreen()/exitFullscreen() call so
  // handleExitPlay() can wait for it to settle before asking the browser's
  // real fullscreenElement — see isCanvasAreaFullscreen()'s comment above
  // for the race this closes.
  const fullscreenRequestRef = useRef<Promise<void> | null>(null);

  // side/sub lifted out of SidePanel.tsx as controlled state — the
  // Dock's Add animation and the stage context bar's Edit animation both
  // need to switch the right rail to Animate › Object, and both live
  // outside SidePanel in the tree (inside Stage). The auto-switch effect
  // (selection present -> object; no selection -> page) moves up here unchanged from
  // SidePanel.tsx's own — same trigger (`hasSelection`), same reasoning in
  // that file's header comment.
  const [side, setSide] = useState<SideId>("chat");
  const [sub, setSub] = useState<SubId>("page");
  const hasSelection = canvasState.selection.ids.length > 0;
  useEffect(() => {
    setSub(hasSelection ? "object" : "page");
  }, [hasSelection]);
  function editSelectionAnimation(): void {
    setSide("animate");
    setSub("object");
  }
  /** §4.5: ContextBar's `Edit style` button — only switches the right rail, exactly like `editSelectionAnimation` above. No command is sent, no selection changes. */
  function editSelectionStyle(): void {
    setSide("style");
    setSub("object");
  }

  // Drag-and-drop/paste media import. This path is unrelated to the old
  // shell's Ribbon insert buttons (those three buttons, plus
  // openMediaPicker/the hidden <input type="file">, were removed along with
  // Ribbon.tsx — the Insert panel's own content is explicitly out of scope
  // here, and no UI entry point calls a file picker anymore), but
  // dragging/pasting an image onto the stage is an existing feature
  // independent of the Ribbon, kept unchanged.
  // Whether the drop overlay (Stage.tsx) is currently showing. Two
  // independent triggers turn it on (the iframe's forwarded "drag-enter"
  // signal below, and a native dragenter over this parent document);
  // only the overlay's own onDrop/onDragLeave turn it off.
  const [dropActive, setDropActive] = useState(false);
  const lastDragSignalRef = useRef(0);

  // canvasState.dragSignal is an edge counter (see its own comment in
  // canvas.ts) — this effect reacts to it *changing*, not to its value, so
  // a second dragenter while the overlay is already up is a harmless no-op
  // re-set rather than something that needs de-duplicating.
  useEffect(() => {
    if (canvasState.dragSignal !== lastDragSignalRef.current) {
      lastDragSignalRef.current = canvasState.dragSignal;
      setDropActive(true);
    }
  }, [canvasState.dragSignal]);

  // A drag entering the parent document's own chrome (ribbon, rail, chat
  // sidebar, ...) never crosses into the sandboxed iframe, so it needs no
  // relay through canvas.ts/selection-runtime.js — a plain listener here
  // sees it directly.
  // Only a file drag may raise the overlay: the rail's thumbnail reorder
  // (overview.ts) is also a native drag, carries "text/plain" only, and
  // never crosses the overlay — so the overlay's own onDrop/onDragLeave
  // would never fire and the stage stayed tinted forever after a reorder.
  // `dragend` bubbles to window for every drag that started in this
  // document, which also covers a thumbnail dragged across the stage iframe
  // (the iframe's forwarded "drag-enter" signal above carries no payload).
  useEffect(() => {
    function onWindowDragEnter(event: globalThis.DragEvent) {
      // [E6.T4] plan §7 decision 8: Deck Space owns its own drop zone while
      // it's open as an overlay — this guard must not also raise the stage
      // overlay underneath it.
      if (deckSpaceOpen) return;
      if (!event.dataTransfer?.types.includes("Files")) return;
      setDropActive(true);
    }
    function onWindowDragEnd() {
      setDropActive(false);
    }
    window.addEventListener("dragenter", onWindowDragEnter);
    window.addEventListener("dragend", onWindowDragEnd);
    return () => {
      window.removeEventListener("dragenter", onWindowDragEnter);
      window.removeEventListener("dragend", onWindowDragEnd);
    };
  }, [deckSpaceOpen]);

  // [E6.T4] plan §7 decision 8: force the drop overlay closed the instant
  // Deck Space opens — a drag that raised it a moment earlier must not
  // leave the stage tinted after Deck Space (and the guard above) closes
  // again.
  useEffect(() => {
    if (deckSpaceOpen) setDropActive(false);
  }, [deckSpaceOpen]);

  // Clipboard paste (US 4/6, docs/asset-import.md) is a window-level event,
  // not something any one element owns — it fires wherever focus happens to
  // be. A paste with no image item (plain text, or nothing) is legitimate
  // and silent, per the plan's behaviour table.
  //
  // The listener itself is attached once (`[]` deps — no reason to
  // re-attach on every render), but `importFile` closes over
  // `presentationInfo`/`canvasState`, which change after mount as
  // `/api/presentation` resolves. A `[]`-effect closure would freeze
  // `importFile` at its *first* render, back when `presentationInfo` was
  // still null — every paste after that would silently no-op forever
  // (`insertImportedAsset`'s own `!canvas` guard). Routing every call
  // through this ref, updated on every render, keeps the listener calling
  // whichever `importFile` is current without re-subscribing it.
  const importFileRef = useRef<((file: File) => Promise<void>) | null>(null);
  importFileRef.current = importFile;

  useEffect(() => {
    function onPaste(event: ClipboardEvent) {
      const items = event.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.kind === "file" && item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) void importFileRef.current?.(file);
          return;
        }
      }
    }
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  /**
   * Inserts the element a successfully-imported asset should produce, via
   * the same `mediaInsertInput` the Image/Video/Audio panels use (D9,
   * [E2.T17]) — a deliberate behaviour change from this function's own
   * previous, now-removed inline geometry (480×270/160×160 absolute pixels,
   * always `kind: "rect"` for video/audio): a dropped file and a
   * panel-inserted one now always produce the same shape of element.
   */
  async function insertImportedAsset(asset: ImportedAsset): Promise<void> {
    const slidePath = currentSlidePath();
    const canvas = presentationInfo?.canvas;
    if (!slidePath || !canvas) return;
    const input = mediaInsertInput(asset.kind, asset.path, canvas);
    await runCanvasCommand("element insert", { slidePath, ...input });
  }

  /** Uploads `file` and, on success, inserts the resulting element. Failure is already surfaced by `controller.importAsset` through `canvasState.error` — nothing more to do here on that path. */
  async function importFile(file: File): Promise<void> {
    const result = await controllerRef.current?.importAsset(file);
    if (result?.ok) {
      await insertImportedAsset(result.data);
    }
  }

  function handleStageDragOver(event: DragEvent): void {
    event.preventDefault();
  }

  function handleStageDrop(event: DragEvent): void {
    event.preventDefault();
    setDropActive(false);
    const files = event.dataTransfer.files;
    // Not a file drop at all (dragged text/a link) — legitimate and
    // unrelated, not an error (§4.2 table).
    if (files.length === 0) return;
    if (files.length > 1) {
      controllerRef.current?.reportError("Only one file can be imported at a time");
      return;
    }
    void importFile(files[0]);
  }

  function handleStageDragLeave(event: DragEvent): void {
    // Only hide once the pointer has actually left the overlay's own
    // bounds — a dragleave fired by a child element bubbling through
    // (relatedTarget still inside) must not hide it prematurely.
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDropActive(false);
  }

  useEffect(() => {
    const container = canvasRef.current;
    if (!container) return;
    const controller = mountCanvas(container);
    controllerRef.current = controller;
    // ⌘Z pressed while focus sits inside the stage iframe arrives as a
    // relayed "stage-key" instead of a document keydown — hand the
    // controller the same `runUndoRedo` so both routes share one fetch path
    // and one editingFrozen gate. Registering the first render's closure is
    // fine: it only reads `editingFrozenRef`, never state directly.
    controller.setUndoRedoHandler(runUndoRedo);
    const unsubscribe = controller.subscribe(setCanvasState);
    // Live reload: the server pushes a `presentation-changed`
    // event over /api/events whenever a slide is modified externally;
    // reload() re-fetches and redraws without React re-rendering anything.
    // Stopped on cleanup — a live EventSource surviving unmount would leak
    // a connection per React StrictMode double-mount.
    const liveReload = startLiveReload({
      onChange: () => {
        void controller.reload();
        // Overview: an external edit can change a slide's
        // markup without project.json's `slides` list moving at all —
        // canvas.subscribe() can't tell that apart from a plain index
        // change, so the overview needs telling explicitly here.
        overviewControllerRef.current?.refresh();
        // #51: an external edit can rename the deck or resize its canvas
        // too — re-fetch the same way overview.ts's own refresh() re-reads
        // the aspect ratio.
        presentationLoaderRef.current?.load();
        // NOOP-93 §4.2: "save-state" is only ever pushed over the SSE
        // stream by /api/save and /api/open (see save-state.ts's own
        // comment — changes.ts's generic disk watcher stays untouched).
        // An ordinary edit reaches here as a plain presentation-changed
        // event with no paired save-state push, so this re-fetches it the
        // same GET-refetch way presentationLoaderRef does above.
        void refreshSaveState();
        // [E2.T8]: an agent's own `comment add`/`edit`/`delete` reaches
        // here the same way any other file write does — this is what
        // makes Pinned context update itself without a page refresh.
        void refreshComments();
        // `slidra-plan`'s `plan set` lands here too — this is what
        // opens the plan-confirmation gate without a page refresh.
        void refreshPlan();
      },
      onError: setLiveReloadError,
      onFrozenChange: setEditingFrozen,
      onSaveStateChange: setSaveState,
      onExportEvent: (event) => setExportState(toExportUiState(event)),
      onCommandsChange: (next) => {
        setCommands(next);
        // `agent-commands` is only sent right after an ACP session is
        // created, when the agent reports its command list — which is also
        // the first moment the model name becomes readable (session/new's
        // response). Piggyback on that same signal to refetch `GET
        // /api/agent`, so the model shown below the chat panel doesn't have
        // to wait for the next reload to appear.
        void refreshAgentStatus();
      },
      // §4.4/Plan §4.6: the only place a system message is
      // ever inserted for a switch — POST /api/agent/select's own 200
      // response never inserts one (Plan §4.5 step 6), including when this
      // same tab is the one that issued the switch: this SSE event is how
      // that tab hears about its own change too, same as every other
      // no-replay event on this stream.
      onAgentChanged: (event) => {
        // [E6.T7] §7 decision 5: the divider itself no longer built here —
        // the server composes it once (`AgentManager.buildDividerText`) and
        // delivers it over `/api/chat/stream`'s own `chat-divider` event
        // (handled in chat-stream.ts), the same channel this tab's message
        // list already listens to. This event still exists purely to
        // refresh the agent-status pill.
        void event;
        void refreshAgentStatus();
      },
      // Switching models doesn't warrant a system message: the pill itself
      // already shows which one is current. This just gets other tabs (or
      // the tab that initiated the switch) to refresh their pill.
      onAgentModelChanged: () => {
        void refreshAgentStatus();
      },
    });
    // The stream's own editing-frozen/editing-unfrozen carry no replay
    // (same reasoning as presentation-changed) — the state as of *this*
    // mount must be fetched directly, or a page loaded mid-turn would show
    // "not frozen" until the turn happens to end.
    void fetch("/api/editing")
      .then((response) => response.json())
      .then((data: { frozen: boolean }) => setEditingFrozen(data.frozen))
      .catch(() => {
        // No fallback value — see the errors-over-fallbacks rule. Leaving
        // the state at its initial `false` here would incorrectly claim
        // "not frozen" on a genuine failure; better to say nothing and let
        // the next presentation-changed/editing-frozen event correct it.
      });
    // Same "GET seeds the initial value, SSE carries updates, no
    // fallback on failure" shape as /api/editing above — a fetch failure
    // leaves `commands` at its initial `[]` rather than fabricating a list.
    // §4.4: agent state follows the same shape, but there is now a
    // corresponding SSE event to subscribe to (agent-changed, see
    // onAgentChanged below).
    void refreshAgentStatus();
    void fetch("/api/agent/commands")
      .then((response) => response.json())
      .then((data: { commands: SlashCommandOption[] }) => setCommands(data.commands))
      .catch(() => {});
    presentationLoaderRef.current?.load();
    void refreshSaveState();
    void refreshComments();
    void refreshPlan();
    return () => {
      liveReload.stop();
      unsubscribe();
      controller.destroy();
      controllerRef.current = null;
    };
  }, []);

  // Overview: mounted once against the canvas controller — it
  // subscribes on its own and needs no React state mirrored back here.
  //
  // `<Rail>` is now unmounted entirely in play mode (see the
  // shellVisible-gated render below), which destroys `overviewRef`'s DOM
  // node. A `[]` dependency array here would only ever run this effect
  // once at the component's very first mount: on returning to view mode,
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
    const overview = mountOverview(container, controller, {
      onContextMenu: (index, x, y) => setContextMenuRequest({ index, x, y }),
      onComment: (index) => void openCommentForPage(index),
    });
    overviewControllerRef.current = overview;
    // A fresh mount (mode toggling back to view, or the component's very
    // first mount) starts with no idea which pages have comments — apply
    // whatever `refreshComments` last computed, rather than waiting for
    // the next reload to paint the red dots in.
    overview.setSlidesWithComments(
      new Set(
        commentsRef.current
          .map((comment) => canvasStateRef.current.slides.indexOf(comment.slidePath))
          .filter((index) => index !== -1),
      ),
    );
    return () => {
      overview.destroy();
      overviewControllerRef.current = null;
    };
  }, [canvasState.mode !== "play"]);

  // [E2.T8]: `slides` changing (initial load, or add/delete/move) always
  // means the deck-wide comment list needs re-reading, even with no
  // presentation-changed event at all yet (the very first `mountCanvas`
  // reload, before any external edit has ever happened) — `onChange`
  // above only fires on an *external* edit, and a comment write never
  // itself changes `slides`, so the two triggers are complementary rather
  // than redundant.
  useEffect(() => {
    void refreshComments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasState.slides]);

  // Arrow keys in view mode page the deck. Legitimate on the
  // parent document: the view-mode iframe is sandboxed with no scripts, so
  // the author's keystrokes never reach it.
  //
  // In play mode the keyboard belongs to the runtime inside the play iframe,
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
  // working. One press of Tab is enough to get there (measured);
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
  // answered by the "Previous"/"Next" buttons, which page the deck without
  // needing a runtime.
  //
  // `canvasStateRef` (not `canvasState` itself) is read inside the
  // listener so this effect never needs to re-subscribe on every state
  // change just to see the current mode.
  const canvasStateRef = useRef(canvasState);
  canvasStateRef.current = canvasState;
  // Master mode's own "remember where I was" (AC1) — the slide index at
  // the moment `enterMasterMode` switches `pageSource` away from
  // `"slides"`, so `exitMasterMode` can restore it. `null` between visits;
  // a plain ref because it drives no render of its own.
  const preMasterIndexRef = useRef<number | null>(null);
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      // Space is play-mode-only (§4.5's own scope — "→ / Space /
      // click to advance" only ever lists it for play mode). In view mode it falls
      // through to the same early return every other unhandled key does,
      // leaving the browser's default Space behaviour untouched there.
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== " ") return;
      // Never steal an arrow key from a text field — the author is moving
      // the caret in the chat box, not paging the deck.
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      const controller = controllerRef.current;
      if (!controller) return;
      const state = canvasStateRef.current;
      if (state.mode === "play") {
        event.preventDefault();
        controller.stepPlayer(event.key === "ArrowLeft" ? "retreat" : "advance");
        // Hand focus back so every following key press takes the runtime's
        // own path, transient activation and all.
        controller.focusPlayer();
        return;
      }
      if (event.key === " ") return;
      event.preventDefault();
      void (event.key === "ArrowRight" ? controller.next() : controller.previous());
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  // Ctrl/Cmd+Z / Ctrl/Cmd+Shift+Z and TitleBar's undo/redo buttons share the
  // same path: `runUndoRedo` is the only place that actually issues
  // /api/undo, /api/redo, so the two fetch flows never drift apart. While
  // frozen, neither path sends a request — not even to be told 409 —
  // matching the existing behavior contract "no request, show the frozen
  // state; must not throw an uncaught error." `editingFrozenRef` (not
  // `editingFrozen` itself) is read inside the listener for the same reason
  // as `canvasStateRef` above — this effect doesn't need to re-subscribe
  // every time frozen flips.
  const editingFrozenRef = useRef(editingFrozen);
  editingFrozenRef.current = editingFrozen;

  // Read by `flushSave` (to return the last-known state on a frozen/failed
  // request without waiting on a re-render) and by the `beforeunload` guard
  // installed below, which must see the CURRENT dirty flag at the moment a
  // close/reload happens, not the value from whenever the effect last ran.
  const saveStateRef = useRef(saveState);
  saveStateRef.current = saveState;
  useEffect(() => installUnsavedGuard(() => saveStateRef.current.known && saveStateRef.current.dirty), []);

  function runUndoRedo(kind: "undo" | "redo"): void {
    if (editingFrozenRef.current) return;
    const path = kind === "redo" ? "/api/redo" : "/api/undo";
    void fetch(path, { method: "POST" }).catch(() => {
      // The server route itself already turns every failure (empty
      // stack, a stale 409) into a JSON error response, not a rejected
      // fetch — this only guards against a genuine network failure, and
      // there is nothing more specific to show than what live reload's
      // own liveReloadError already surfaces for a dead connection.
    });
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== "z" && event.key !== "Z") return;
      if (!(event.ctrlKey || event.metaKey)) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      event.preventDefault();
      runUndoRedo(event.shiftKey ? "redo" : "undo");
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  // event.key for Shift+] is "}" on a US layout (not "]"), and on
  // non-US layouts the bracket may sit on a different key entirely —
  // event.code identifies the physical key regardless of layout or
  // Shift. Both are accepted so the order shortcuts fire from the
  // physical bracket key a real keyboard sends, not just the character
  // string a same-layout dispatch happens to produce.
  function isBracketRightInput(event: KeyboardEvent): boolean {
    return event.key === "]" || event.key === "}" || event.code === "BracketRight";
  }
  function isBracketLeftInput(event: KeyboardEvent): boolean {
    return event.key === "[" || event.key === "{" || event.code === "BracketLeft";
  }

  // ⌘A / Delete / Backspace / ⌘D / ⌘] / ⌘[ / ⌘⇧] / ⌘⇧[ (NOOP-90/T2 §4.4) — the
  // PARENT document's own half of the keyboard relay. When focus sits
  // INSIDE the sandboxed iframe (e.g. right after clicking a slide
  // element), this listener never fires at all for that keypress — the
  // browser delivers it to the iframe's own document — which is exactly
  // why selection-runtime.js/canvas.ts's own "stage-key" relay
  // (handleSelectionMessage) exists as this handler's other half; both
  // paths call the same `controller` methods, so the two can never drift.
  // Play mode disables every one of these, same as the ⌘Z effect above
  // disables during a frozen edit.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      const controller = controllerRef.current;
      if (!controller || canvasStateRef.current.mode !== "view") return;
      const withModifier = event.metaKey || event.ctrlKey;

      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        void controller.deleteSelection();
        return;
      }
      if (withModifier && event.key === "a") {
        event.preventDefault();
        controller.selectAll();
        return;
      }
      if (withModifier && event.key === "d") {
        event.preventDefault();
        void controller.duplicateSelection();
        return;
      }
      if (withModifier && isBracketRightInput(event)) {
        event.preventDefault();
        void controller.orderSelection(event.shiftKey ? "front" : "up");
        return;
      }
      if (withModifier && isBracketLeftInput(event)) {
        event.preventDefault();
        void controller.orderSelection(event.shiftKey ? "back" : "down");
        return;
      }
      // §3.8/A0: measured under headless Chromium, a pure keyboard trigger
      // like Ctrl/Cmd+C does not make the browser fire a native
      // `copy`/`cut` ClipboardEvent — Chromium only fires that event when
      // there is genuinely selectable content (a native text selection, or
      // focus on an editable field), and our canvas selection is a Shadow
      // DOM overlay, which from the browser's point of view means "nothing
      // is selected." Fall back to the documented alternate path instead:
      // treat ⌘C/⌘X/⌘V as plain keystrokes, reading/writing through the
      // async `navigator.clipboard` API rather than relying on
      // ClipboardEvent. ⌘V coexists without conflict with the existing
      // native `paste` listener above (which only recognizes images):
      // when the clipboard holds an image, `readText()` returns an empty
      // string, and `pasteFromText` treats that as an empty clipboard and
      // silently no-ops.
      if (withModifier && event.key === "c") {
        event.preventDefault();
        void controller.copySelection().then((svg) => {
          if (svg) void navigator.clipboard.writeText(svg);
        });
        return;
      }
      if (withModifier && event.key === "x") {
        void controller.cutSelection().then((svg) => {
          if (svg) void navigator.clipboard.writeText(svg);
        });
        event.preventDefault();
        return;
      }
      if (withModifier && event.key === "v") {
        event.preventDefault();
        void navigator.clipboard.readText().then((text) => controller.pasteFromText(text));
        return;
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  // ⌘D / Delete / PageUp / PageDown (§4.3). Appended after the
  // two keydown effects above, not merged into either — same
  // text-field/contentEditable guard as both (§3.7).
  // `canvasStateRef` (declared above, next to the ArrowLeft/Right effect)
  // is read here for the same reason that effect reads it: this listener
  // must not re-subscribe on every canvasState change.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      const controller = controllerRef.current;
      if (!controller) return;
      const state = canvasStateRef.current;

      if (event.key === "PageUp" || event.key === "PageDown") {
        if (state.mode === "play") {
          event.preventDefault();
          controller.stepPlayer(event.key === "PageDown" ? "advance" : "retreat");
          controller.focusPlayer();
          return;
        }
        event.preventDefault();
        void (event.key === "PageDown" ? controller.next() : controller.previous());
        return;
      }

      // ⌘D / Delete belong to view mode only — play mode already returns above
      // for the two keys this effect otherwise cares about.
      if (state.mode === "play") return;

      const isDelete = event.key === "Delete" || event.key === "Backspace";
      const isDuplicate =
        (event.key === "d" || event.key === "D") && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey;
      if (!isDelete && !isDuplicate) return;

      // When there's a selection, both keys are left for a separate
      // handler — no preventDefault, no-op here (§2 boundary 5).
      if (state.selection.ids.length > 0) return;
      // With no selection, the "act on the current page" intent only holds
      // when focus is actually on the rail/thumbnail area — right after
      // page load, or while focus is still on the canvas/iframe, this stays
      // a no-op, left to the other handler (which also does nothing). Fixes
      // a regression where this used to unconditionally send a slide
      // delete, so pressing Delete with nothing selected would delete the
      // entire current slide.
      const activeElement = document.activeElement;
      if (!(activeElement instanceof HTMLElement) || !activeElement.closest(".rail")) return;
      if (state.slides.length === 0) return;

      const slidePath = state.slides[state.currentIndex];
      if (isDelete) {
        event.preventDefault();
        const newLength = state.slides.length - 1;
        void runPageCommand("slide delete", { slidePath }, newLength === 0 ? null : Math.min(state.currentIndex, newLength - 1));
        return;
      }

      event.preventDefault(); // isDuplicate — otherwise Chrome opens "Add bookmark".
      void runPageCommand("slide duplicate", { slidePath }, state.currentIndex + 1);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  // Cell-range keyboard shortcuts (E2.T14r2 §4.3) — path B of the two the
  // range's keyboard contract needs (§3.2 of the plan): focus sitting in
  // THIS document rather than inside the sandboxed iframe, e.g. right after
  // a cell edit's <input> blurs. Registered on the CAPTURE phase
  // deliberately: capture on a given node is always ordered before that
  // same node's own bubble-phase listeners per the DOM spec, so this
  // effect's `stopPropagation()` on a handled key reliably pre-empts the
  // four bubble-phase effects above (⌘A/Delete/⌘D/⌘]/⌘[ in particular,
  // which would otherwise delete the whole table on a range Delete) without
  // depending on registration order — unlike registration order, capture-
  // before-bubble is guaranteed regardless of how the component tree
  // reshuffles these effects relative to each other. None of the four
  // existing effects change: the guard below returns before doing anything
  // whenever `handleTableRangeKey` says the key does not belong to it, so
  // every pre-existing shortcut keeps behaving exactly as before.
  useEffect(() => {
    function onKeyDownCapture(event: KeyboardEvent): void {
      const target = event.target as HTMLElement | null;
      // Same guard, verbatim, as the four bubble-phase effects above — most
      // importantly, this is the only reason a cell editor's own <input>
      // Enter/Escape still work: calling stopPropagation() here would
      // otherwise swallow those synthetic React events too.
      if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      const controller = controllerRef.current;
      if (!controller || canvasStateRef.current.mode !== "view") return;
      const handled = controller.handleTableRangeKey(event.key, {
        meta: event.metaKey,
        ctrl: event.ctrlKey,
        shift: event.shiftKey,
      });
      if (handled) {
        event.preventDefault();
        event.stopPropagation();
      }
    }
    document.addEventListener("keydown", onKeyDownCapture, true);
    return () => document.removeEventListener("keydown", onKeyDownCapture, true);
  }, []);

  // §4.5: Esc leaves play mode — but only when the document is not
  // ALSO fullscreen right now. Fullscreen owns Esc first: the browser is
  // already exiting fullscreen on its own by the time this fires, and
  // `isCanvasAreaFullscreen` here (checked before calling handleExitPlay(),
  // not inside it) is what keeps that a "leave fullscreen, stay in play
  // mode" transition rather than dropping out of both at once (the same
  // rule canvas.ts's onWindowMessage applies to the runtime's own
  // "exit-play" message — the other route to this same call). `handleExitPlay`
  // is a hoisted function declaration, so referencing it here (defined
  // further down this component) is safe.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== "Escape") return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      if (canvasStateRef.current.mode !== "play") return;
      if (isCanvasAreaFullscreen(wellRef.current)) return;
      void handleExitPlay();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  /**
   * `GET /api/agent` (NOOP-230 §4.4) — the one place `agentStatus` is ever
   * set from a cached read. Used for the initial mount fetch, after a
   * successful `POST /api/agent/select` (Plan §4.5 step 3: re-GET rather
   * than reusing select's own partial `{ok,current,source}` response), and
   * whenever `agent-changed` arrives. A malformed response is dropped
   * (`fromAgentResponse` returning `null`) — the previous value is kept,
   * same "errors over fallbacks" rule every other GET in this file follows.
   * A network failure surfaces as `{ kind: "error" }` rather than being
   * swallowed, since ChatPanel's empty state has nothing else to show for
   * "the agent list itself could not be read".
   */
  async function refreshAgentStatus(): Promise<void> {
    setAgentProbing(true);
    try {
      const response = await fetch("/api/agent");
      const data: unknown = await response.json();
      const parsed = fromAgentResponse(data);
      if (parsed) setAgentStatus(parsed);
      const models = modelOptionsFrom(data);
      setAgentModelOptions(models.options);
      setAgentModelId(models.current);
      // #303: a turn already in flight (started before this tab loaded, or
      // from another client) shows Stop right away.
      setWorking(turnRunningFrom(data));
      setWriteIsolation(writeIsolationFrom(data));
    } catch {
      setAgentStatus({ kind: "error", message: "Could not get agent status: connection lost" });
    } finally {
      setAgentProbing(false);
    }
  }

  /** `POST /api/agent/model`: the model menu below the chat panel. On failure (turn in progress, model doesn't exist, connection lost) it goes through the chat's error strip, and state stays at its previous value. */
  async function selectAgentModel(modelId: string): Promise<void> {
    if (modelId === "" || modelId === agentModelId) return;
    try {
      const response = await fetch("/api/agent/model", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelId }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        pushChatError(body.error ?? "Failed to switch model");
        return;
      }
      await refreshAgentStatus();
    } catch {
      pushChatError("Failed to switch model: connection lost");
    }
  }

  /** `POST /api/agent/session`: "Choose model…" — must create a session first, or the list stays empty. */
  async function loadAgentModels(): Promise<void> {
    try {
      const response = await fetch("/api/agent/session", { method: "POST" });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        pushChatError(body.error ?? "Could not get model list");
        return;
      }
      await refreshAgentStatus();
    } catch {
      pushChatError("Could not get model list: connection lost");
    }
  }

  /** `POST /api/agent/probe` (Plan §4.4 "Re-detect") — always reruns both login probes (§7.7), unlike the cached `GET /api/agent` above. Failure leaves `agentStatus` at its last known value (Plan: "failure → show error strip, state stays at its previous value"). */
  async function handleProbeAgent(): Promise<void> {
    setAgentProbing(true);
    setAgentActionError(null);
    try {
      const response = await fetch("/api/agent/probe", { method: "POST" });
      const data: unknown = await response.json();
      const parsed = fromAgentResponse(data);
      if (parsed) setAgentStatus(parsed);
    } catch {
      setAgentActionError("Re-detect failed: connection lost");
    } finally {
      setAgentProbing(false);
    }
  }

  /**
   * `POST /api/agent/select` (Plan §4.5) — deliberately pessimistic, no
   * optimistic `current` update: a switch replaces the whole ACP session,
   * and rolling an optimistic update back on failure would visibly flicker
   * between agents and race `agent-changed`'s own write to the same state.
   */
  async function handleSelectAgent(kind: AgentKind): Promise<void> {
    setAgentSwitchingKind(kind);
    setAgentActionError(null);
    let response: Response;
    try {
      response = await fetch("/api/agent/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind }),
      });
    } catch {
      setAgentActionError("Failed to switch agent: connection lost");
      setAgentSwitchingKind(null);
      return;
    }
    if (response.ok) {
      await refreshAgentStatus();
      setAgentSwitchingKind(null);
      return;
    }
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    setAgentActionError(body.error ?? "Failed to switch agent");
    setAgentSwitchingKind(null);
  }

  /** `GET /api/save-state` (§4.2). A failed request leaves `saveState` exactly as it was — the table's row 4 ("keep the existing deckName behavior, show no status text" for a `known:false` starting point, or simply the last good value once one has ever loaded). */
  async function refreshSaveState(): Promise<void> {
    try {
      const response = await fetch("/api/save-state");
      if (!response.ok) return;
      const data = (await response.json()) as SaveState;
      setSaveState(data);
    } catch {
      // Network failure — same "say nothing, let the next signal correct
      // it" rule /api/editing's own fetch above follows.
    }
  }

  /**
   * The title bar's own double-click rename (`TitleBar`'s `onRenameDeck`).
   * `POST /api/deck/rename-current` already re-points the file watcher at
   * the new path server-side; `refreshSaveState` picks up the new
   * `fileName` for this tab the same way it does after any other save-state
   * change, and the server's own broadcast (`save-state`) updates any other
   * tab that has this deck open.
   */
  async function handleRenameDeck(name: string): Promise<string | null> {
    const result = await renameCurrentDeck(name);
    if (result.ok) {
      await refreshSaveState();
      return null;
    }
    if (result.reason === "name-conflict") return "A deck with that name already exists";
    if (result.reason === "editing" || result.reason === "exporting") {
      return "Can't rename right now — try again in a moment";
    }
    return result.error;
  }

  /**
   * `POST /api/save/flush` (NOOP-422) — continuous save's manual escape
   * hatches: the Retry action on a failed save, and
   * `applyTemplateToSlides`'s pre-dispatch save. Frozen
   * guard matches runUndoRedo's: no request, no 409 to report, same as
   * undo/redo. Returns the resulting save state (not just success/failure)
   * — callers that need to know whether the write actually landed check
   * `known && !dirty` on the result, same as they would on `saveState`
   * itself; the server also broadcasts it, so this tab's own state updates
   * either way.
   */
  async function flushSave(): Promise<SaveState> {
    if (editingFrozenRef.current) return saveStateRef.current;
    setOpenError(null);
    let response: Response;
    try {
      response = await fetch("/api/save/flush", { method: "POST" });
    } catch {
      setOpenError("Failed to save: connection lost");
      return saveStateRef.current;
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      setOpenError(body.error ?? "Failed to save");
      return saveStateRef.current;
    }
    const data = (await response.json()) as SaveState;
    setSaveState(data);
    return data;
  }

  /**
   * `POST /api/export` (§4.7). The panel closes and switches to
   * "Exporting…" immediately, optimistically — every subsequent state
   * transition (running/progress/done/error for a job that actually
   * started) arrives over the `export` SSE event instead. A 409 (already
   * one running) or a network failure overwrites that optimistic state with
   * the real error immediately, using the same error strip a genuine
   * mid-job `error` event would show.
   */
  async function handleExportPick(format: ExportFormat): Promise<void> {
    setExportOpen(false);
    setExportState({ kind: "busy", format, completedFrames: 0, totalFrames: 0 });
    let response: Response;
    try {
      response = await fetch("/api/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ format }),
      });
    } catch {
      setExportState({ kind: "error", message: "Export failed: connection lost" });
      return;
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      setExportState({ kind: "error", message: body.error ?? "Export failed" });
    }
  }

  // Fullscreen toggle: fullscreenchange only syncs UI state here — it
  // must never call exitPlay(). Leaving fullscreen (including Esc) returns
  // to inline play, not out of play mode (design doc's fullscreen section:
  // fullscreen is not a separate mode). Registers both the unprefixed and
  // WebKit-prefixed event names.
  useEffect(() => {
    function onFullscreenChange(): void {
      setIsFullscreen(isCanvasAreaFullscreen(wellRef.current));
      // This event firing at all means the browser's real fullscreen state
      // just genuinely changed — by Esc, by browser chrome, or by our own
      // button — which makes any earlier "a fullscreen request failed"
      // message stale no matter how it got there (a stale fullscreenError
      // used to sit on screen after a later, successful exit/enter until
      // the next click cleared it by hand).
      setFullscreenError(null);
      // Every fullscreen transition must hand focus back to the player, or
      // arrow-key advance silently dies. A no-op
      // outside play mode (focusPlayer() itself gates on mode === "play").
      controllerRef.current?.focusPlayer();
    }
    document.addEventListener("fullscreenchange", onFullscreenChange);
    document.addEventListener("webkitfullscreenchange", onFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      document.removeEventListener("webkitfullscreenchange", onFullscreenChange);
    };
  }, []);

  // Leaving play mode by any route ("Exit play" button, live reload emptying the
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
        setFullscreenError(error instanceof Error ? error.message : "Failed to exit fullscreen");
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
      setFullscreenError("This browser doesn't support Fullscreen");
      // A failed request still leaves focus on the toggle button. Wait for
      // the error render, then hand keyboard control back to the player.
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
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
      setFullscreenError(error instanceof Error ? error.message : "Failed to enter fullscreen");
    } finally {
      // Only clear the ref if it still points at *this* call's own promise
      // (same guard the exit branch above already uses). Two clicks in
      // quick succession each capture their own promise in this closure;
      // an unconditional clear here would let an earlier call's `finally`
      // wipe out a later, still in-flight call's promise the moment the
      // earlier one settles — handleExitPlay() would then have nothing to
      // await for the request that is actually still pending.
      if (fullscreenRequestRef.current === requestPromise) fullscreenRequestRef.current = null;
    }
    controllerRef.current?.focusPlayer();
  }

  async function handleExitPlay(): Promise<void> {
    // If still fullscreen when leaving play mode, fullscreen must be exited
    // first, or the document will get stuck fullscreen with no player left
    // underneath it (behaviour contract table, row 4). A
    // requestFullscreen() call started just before this click can still be
    // pending here — isFullscreen (React state) has not been updated yet,
    // so trusting it would skip exiting, and the pending request would
    // still land after play mode's chrome (including the exit-fullscreen
    // button) is already gone, leaving the document genuinely stuck
    // fullscreen. Wait for any in-flight request to settle first, then
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
  // NOOP-425 AC7: starts optimistic (no warning shown) until the first
  // `GET /api/agent` resolves, same "assume the quieter state" rule
  // `writeIsolationFrom` itself follows for a malformed/missing field.
  const [writeIsolation, setWriteIsolation] = useState<WriteIsolationView>({ active: true, reason: null });
  /** Errors go into the message timeline: they stay attached to whichever message they followed, rather than as a bar pinned to the bottom that outlives its relevance. */
  function pushChatError(text: string): void {
    setMessages((prev) => appendErrorMessage(prev, nextMessageIdRef.current++, text));
  }
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
    // [E6.T7] AC1/AC2: restores the thread persisted in the deck's own
    // file before ever connecting the live stream — `/api/chat/stream`
    // carries no replay (same reasoning as every other SSE channel in this
    // app), so a page reload or a freshly reopened deck would otherwise
    // show an empty conversation until the next message happened to
    // arrive. A failed/absent history (no deck open yet, a fresh
    // presentation with no history) is not an error to surface — same
    // "GET seeds the initial value, no fallback on failure" shape every
    // other mount-time GET in this component already follows.
    let cancelled = false;
    let stream: ChatStream | undefined;

    async function bootstrapThenConnect(): Promise<void> {
      try {
        const response = await fetch("/api/chat/history?limit=1000");
        if (response.ok && !cancelled) {
          const data = (await response.json()) as { entries: PersistedChatEntry[]; truncated: boolean };
          const restored = restoreChatMessages(data.entries, nextMessageIdRef.current, data.truncated);
          nextMessageIdRef.current = restored.nextId;
          setMessages(restored.messages);
        }
      } catch {
        // Connection lost before the very first render settled — nothing
        // to restore; the live stream below still connects normally.
      }
      if (cancelled) return;
      // All of the turn bookkeeping — including what happens to a turn
      // whose ending is lost to a dropped connection — lives in
      // chat-stream.ts so it can be tested without rendering React
      // (ticket #19).
      stream = startChatStream({
        updateMessages: setMessages,
        setWorking,
        setStreamReady,
        nextMessageId: () => nextMessageIdRef.current++,
      });
    }

    void bootstrapThenConnect();
    return () => {
      cancelled = true;
      stream?.stop();
    };
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

  /**
   * The one path that actually posts to `/api/chat` — `sendMessage()`
   * (the chat input) and `draftWithAgent()` ([E2.T8]'s `Draft with agent`)
   * both fun through here so the honest-failure handling below is written
   * once. `text` is exactly what appears in the conversation as the
   * author's own message (`Draft with agent`'s fixed prefix included —
   * §4.8 of the plan: the author sees what was actually sent).
   */
  async function sendChatText(text: string, displayText?: string): Promise<void> {
    if (!streamReady) {
      // Honest refusal, not a silent drop or a silent queue: the author
      // can see the chat is not ready yet instead of losing the message
      // with no trace.
      pushChatError("Chat connection isn't ready yet. Please wait and try again.");
      return;
    }
    const id = nextMessageIdRef.current++;
    setMessages((prev) => appendMessage(prev, id, "author", displayText ?? text));
    // The turn starts here, not at its first SSE event: an agent that
    // reads and thinks for a while before saying anything would otherwise
    // leave the author looking at a screen with no sign it is working.
    // Every ending — `chat-done`, `chat-error`, a dropped stream — still
    // clears it from chat-stream.ts, as does a send that never landed.
    setWorking(true);
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(displayText === undefined ? { text } : { text, displayText }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string; reason?: string };
        setWorking(false);
        pushChatError(body.error ?? "Failed to send message");
        // NOOP-230 §4.4/Plan §4.8: a `reason`-carrying 409 means the server's
        // own agent state disagrees with what this tab last knew (unset/
        // unauthenticated) — re-GET so the empty state appears immediately,
        // instead of waiting for the author to happen to open settings.
        if (response.status === 409 && (body.reason === "unset" || body.reason === "unauthenticated")) {
          void refreshAgentStatus();
        }
      }
    } catch {
      // `fetch` rejects (rather than resolving with a non-OK response) when
      // the connection drops entirely — e.g. the server going away between
      // `streamReady` and this call. The message is already rendered above
      // by this point, so without this catch the author would see their
      // message sitting in the conversation as if it had been delivered,
      // when it was not — fabricating success is forbidden here. Reuses
      // the same `error` state the non-OK branch above uses, naming the
      // message so it is clear which one failed.
      setWorking(false);
      pushChatError(`"${text}" failed to send: connection lost. This message was not sent.`);
    }
  }

  /**
   * An empty draft is still a real request when comments are pinned —
   * "do what the pins say" — so it goes out, with the conversation showing
   * a placeholder rather than an empty bubble. The placeholder is only
   * what is *displayed*; what reaches the agent is the pinned-comment
   * context plus its own instruction (session.ts), never this text.
   */
  async function sendMessage(): Promise<void> {
    const text = draft.trim();
    if (!text && comments.length === 0) return;
    setDraft("");
    await sendChatText(text, text ? undefined : `(No message entered — sending ${comments.length} pinned comment(s) only)`);
  }

  /**
   * `OutlineModal`'s `Draft with agent` — a plain chat
   * message invoking the shipped `/slidra-plan` skill (the same text an
   * author would type by hand, so the skill really triggers), with
   * a fixed position line (contract §4), sent through the exact same path
   * a hand-typed message takes (architecture decision: no separate API, no
   * client-side outline parsing). The skill writes `plan/outline.md`,
   * which opens `<PlanGateModal>` below; building only starts from that
   * gate's "Confirm and build". A presentation with no slides yet (`new`
   * creates none) is a real request too — not a no-op.
   */
  async function draftWithAgent(outline: string): Promise<void> {
    const count = canvasState.slides.length;
    const position =
      count === 0
        ? "[plan-from-outline] This presentation has no slides yet."
        : `[plan-from-outline] There are ${count} pages so far; new pages will be appended at the end.`;
    await sendChatText(`/slidra-plan ${position}\n\n${outline}`);
  }

  /**
   * Rail's mode toggle, entering (AC1) — remembers the slide the author
   * was looking at, then hands `canvasState.slides`/`currentIndex` over to
   * the deck's templates. Frozen guard matches Save/undo/redo's own.
   */
  async function enterMasterMode(): Promise<void> {
    if (editingFrozenRef.current) return;
    const controller = controllerRef.current;
    if (!controller) return;
    preMasterIndexRef.current = canvasStateRef.current.currentIndex;
    await controller.setPageSource("templates");
  }

  /**
   * Leaving restores the slide view and the previously selected slide
   * (AC1). The remembered index is clamped to the deck's current slide
   * count rather than trusted outright: `showSlide` throws on an
   * out-of-range index, and nothing rules out a concurrent external edit
   * shortening the deck while this tab sat in master mode.
   */
  async function exitMasterMode(): Promise<void> {
    const controller = controllerRef.current;
    if (!controller) return;
    const from = preMasterIndexRef.current;
    preMasterIndexRef.current = null;
    await controller.setPageSource("slides");
    const slideCount = canvasStateRef.current.slides.length;
    if (from !== null && from >= 0 && slideCount > 0) {
      await controller.showSlide(Math.min(from, slideCount - 1));
    }
  }

  /**
   * "Let the agent update the slides" (AC3): flushes the pending save
   * first — the agent reads the change off disk, not off whatever this tab
   * still has in memory — then dispatches `buildApplyMasterMessage` through
   * the exact same `sendChatText` path `draftWithAgent` above uses. A
   * failed flush does not dispatch (`flushSave`'s own `setOpenError`
   * already reported why); `sendChatText`'s existing honest-refusal handles
   * a `streamReady === false` race on its own — the save already happened
   * either way, and is never rolled back.
   */
  async function applyTemplateToSlides(templateName: string | null): Promise<void> {
    if (editingFrozenRef.current) return;
    const controller = controllerRef.current;
    const state = canvasStateRef.current;
    if (!controller || state.pageSource !== "templates" || state.currentIndex === -1) return;
    const templatePath = state.slides[state.currentIndex];
    const saved = await flushSave();
    if (!(saved.known && !saved.dirty)) return;
    await sendChatText(buildApplyMasterMessage({ templatePath, templateName, slideCount: controller.deckSlideCount }));
  }

  /**
   * The chat panel's Stop button — `POST /api/chat/cancel`. The
   * turn's actual end still arrives over the stream (`chat-done` with
   * `stopReason: "cancelled"`, which chat-stream.ts turns into the "Stopped"
   * line); this only asks. A 409 means the turn had already ended by the
   * time the author pressed Stop — nothing to show beyond clearing the
   * in-flight state, since the stream's own ending already did the rest.
   */
  const [stopping, setStopping] = useState(false);
  async function stopChatTurn(): Promise<void> {
    if (stopping) return;
    setStopping(true);
    try {
      const response = await fetch("/api/chat/cancel", { method: "POST" });
      if (!response.ok && response.status !== 409) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        pushChatError(body.error ?? "Failed to stop");
      }
    } catch {
      pushChatError("Failed to stop: connection lost");
    } finally {
      setStopping(false);
    }
  }

  /**
   * The "New chat" button next to Send — `POST /api/chat/new`. The server
   * drops the current ACP session and opens a fresh one with the same
   * agent. [E6.T7] §7 decision 4: the message list is no longer cleared
   * here — the conversation is now persisted in the deck's own file, so
   * clearing the screen would just have it reappear on the next reload,
   * screen and file disagreeing in the meantime. The server inserts a
   * divider instead (delivered over `/api/chat/stream`'s `chat-divider`
   * event, same as an agent switch) marking where the reset happened. The
   * presentation itself is entirely untouched.
   */
  async function startNewChatSession(): Promise<void> {
    try {
      const response = await fetch("/api/chat/new", { method: "POST" });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        pushChatError(body.error ?? "Could not start a new conversation");
      }
    } catch {
      pushChatError("Could not start a new conversation: connection lost");
    }
  }

  /** slidePath = the current slide's virtual path. */
  function currentSlidePath(): string | null {
    return canvasState.slides[canvasState.currentIndex] ?? null;
  }

  type CommandResult = { ok: boolean; message: string; data?: unknown };

  /** Runs a canvas command through the one write path (`controller.runCommand`) — used by the drag/drop/paste media-import flow above, and by `<Notes>`'s `slide notes set`. */
  async function runCanvasCommand(name: string, input: Record<string, unknown>): Promise<CommandResult | undefined> {
    return controllerRef.current?.runCommand(name, input);
  }

  /**
   * `slide add`/`duplicate`/`move`/`delete` all change which page
   * is "current" — plain `reload()` only clamps `currentIndex` into range
   * on an external edit, it never jumps to a *specific* new page (§7
   * decision 6). Waiting for the write's own `/api/events`-triggered reload
   * instead of doing this explicitly would race: which one lands first is
   * not guaranteed. `targetIndex === null` means "no page to land on"
   * (deleting the deck down to zero slides).
   */
  async function runPageCommand(
    name: string,
    input: Record<string, unknown>,
    targetIndex: number | null,
  ): Promise<CommandResult | undefined> {
    const result = await runCanvasCommand(name, input);
    if (result?.ok) {
      await controllerRef.current?.reload();
      if (targetIndex !== null) await controllerRef.current?.showSlide(targetIndex);
    }
    return result;
  }

  // --- [E2.T8]: comments ---

  /**
   * Reloads the deck-wide comment list — mount, and every
   * presentation-changed event (an agent's own `comment add`/`edit`/`delete`
   * reaches here over the exact same channel a GUI-originated write does).
   * A per-slide fetch/parse failure surfaces once through the existing
   * `CanvasState.error` channel (`reportError`) rather than being read as
   * "no comments" (§4.7 of the plan).
   */
  async function refreshComments(): Promise<void> {
    const slides = canvasStateRef.current.slides;
    const { comments: fetched, errors } = await fetchDeckComments(slides);
    setComments(sortComments(fetched, slides));
    const withComments = new Set(
      fetched.map((comment) => slides.indexOf(comment.slidePath)).filter((index) => index !== -1),
    );
    overviewControllerRef.current?.setSlidesWithComments(withComments);
    if (errors.length > 0) controllerRef.current?.reportError(errors[0]);
  }

  /**
   * #303: re-reads `plan/outline.md` through the same `/api/files/` route
   * every other virtual path uses (it goes through `cat`, so a missing
   * file is an honest 404 → no plan). A parse failure is logged by
   * `parsePlanOutline` and treated as no plan — never thrown into render.
   */
  async function refreshPlan(): Promise<void> {
    try {
      const response = await fetch("/api/files/plan/outline.md");
      if (response.status === 404) {
        setPlanOutline(null);
        return;
      }
      if (!response.ok) {
        console.warn(`Failed to read plan/outline.md: HTTP ${response.status}`);
        return;
      }
      setPlanOutline(parsePlanOutline(await response.text()));
    } catch (error) {
      console.warn(`Failed to read plan/outline.md: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** The gate's two agent-bound exits (contract §4) — remember the draft so the same file cannot re-open the gate while the agent works. */
  function answerPlan(text: string): void {
    if (planOutline) setAnsweredPlanFence(planOutline.fenceText);
    void sendChatText(text);
  }

  /** Discard: the one exit that needs no agent — deletes the whole `plan/`; the gate closes when the refetch finds nothing. */
  async function discardPlan(): Promise<void> {
    const result = await runCanvasCommand("plan delete", {});
    if (result && !result.ok) {
      controllerRef.current?.reportError(result.message);
      return;
    }
    await refreshPlan();
  }

  function findComment(slidePath: string, target: string): NumberedComment | undefined {
    return commentsRef.current.find((comment) => comment.slidePath === slidePath && comment.target === target);
  }

  function openComposerFor(slidePath: string, target: string): void {
    const existing = findComment(slidePath, target);
    setCommentComposerTarget(target);
    setCommentEditingId(existing?.id ?? null);
    setCommentDraft(existing?.text ?? "");
  }

  /** ContextBar's "Comment to AI": target is the single selected element, or "page" for 0/2+ selected (§4.7 of the plan). */
  function openCommentForSelection(): void {
    const slidePath = canvasStateRef.current.slides[canvasStateRef.current.currentIndex];
    if (slidePath === undefined) return;
    const ids = canvasStateRef.current.selection.ids;
    openComposerFor(slidePath, ids.length === 1 ? ids[0] : "page");
  }

  /** overview.ts's thumbnail comment button: jump to that page, clear selection, open a whole-page composer (§4.7). */
  async function openCommentForPage(index: number): Promise<void> {
    await controllerRef.current?.showSlide(index);
    controllerRef.current?.clearSelection();
    const slidePath = canvasStateRef.current.slides[index];
    if (slidePath === undefined) return;
    openComposerFor(slidePath, "page");
  }

  /** `.comment-pin` click, and Pinned context's own row click land here once the target slide/selection are already in place — opens that exact comment for editing. */
  function openCommentForEdit(comment: NumberedComment): void {
    setCommentComposerTarget(comment.target);
    setCommentEditingId(comment.id);
    setCommentDraft(comment.text);
  }

  /** Pinned context row click (§4.7): jump to its slide, select its target (or clear selection for a page-level one), then open it for editing. */
  async function openPinnedComment(comment: NumberedComment): Promise<void> {
    const index = canvasStateRef.current.slides.indexOf(comment.slidePath);
    if (index !== -1) {
      // `showSlide` resets selection and re-navigates the iframe even
      // when `index` is already current — `selectAfter` is the only
      // race-safe way to select something once that settles (see
      // canvas.ts's own `showSlide` comment: calling the separate
      // `selectElement` right after this promise resolves would race the
      // iframe's navigation and be silently dropped, NOOP-227).
      // `clearSelection` needs no such care — it never depends on the
      // runtime reporting a bounding box back.
      await controllerRef.current?.showSlide(index, comment.target === "page" ? undefined : [comment.target]);
    }
    if (comment.target === "page") controllerRef.current?.clearSelection();
    openCommentForEdit(comment);
  }

  function closeCommentComposer(): void {
    setCommentComposerTarget(null);
    setCommentEditingId(null);
    setCommentDraft("");
  }

  async function submitComment(): Promise<void> {
    const slidePath = canvasStateRef.current.slides[canvasStateRef.current.currentIndex];
    const target = commentComposerTarget;
    const text = commentDraft.trim();
    if (slidePath === undefined || target === null || text === "") return;
    const result =
      commentEditingId !== null
        ? await runCanvasCommand("comment edit", { slidePath, commentId: commentEditingId, text })
        : await runCanvasCommand("comment add", { slidePath, target, text });
    // Failure (including the agent's editing lock, 409) leaves the composer
    // open with the draft intact so the author can retry (§4.7's table).
    if (result?.ok) closeCommentComposer();
  }

  /** The open composer's own Delete button. */
  async function deleteOpenComment(): Promise<void> {
    const slidePath = canvasStateRef.current.slides[canvasStateRef.current.currentIndex];
    if (slidePath === undefined || commentEditingId === null) return;
    const result = await runCanvasCommand("comment delete", { slidePath, commentId: commentEditingId });
    if (result?.ok) closeCommentComposer();
  }

  /** Pinned context's own ✕ (§4.7): deletes immediately, no confirmation, never touches the composer. */
  async function deletePinnedComment(comment: NumberedComment): Promise<void> {
    await runCanvasCommand("comment delete", { slidePath: comment.slidePath, commentId: comment.id });
  }

  /** `SelectionOverlay`'s pin (§3.9/§4.7): only for a single-element selection, and only when that element already has a comment on the current slide. */
  function resolvePinForSelection(): { commentId: string; number: number; onClick(): void } | null {
    if (canvasState.selection.ids.length !== 1) return null;
    const slidePath = currentSlidePath();
    if (slidePath === null) return null;
    const found = findComment(slidePath, canvasState.selection.ids[0]);
    if (!found) return null;
    return { commentId: found.id, number: found.number, onClick: () => openCommentForEdit(found) };
  }

  const shellVisible = canvasState.mode !== "play";

  return (
    <div className="app" data-mode={canvasState.mode}>
      {shellVisible &&
        planOutline !== null &&
        planOutline.status === "draft" &&
        planOutline.questions.length > 0 &&
        planOutline.fenceText !== answeredPlanFence && (
          <PlanGateModal key={planOutline.fenceText} outline={planOutline} onSend={answerPlan} onDiscard={() => void discardPlan()} />
        )}
      {shellVisible && (
        <TitleBar
          deckName={saveState.known ? saveState.fileName : (presentationInfo?.name ?? null)}
          onRenameDeck={handleRenameDeck}
          savedStatusText={saveState.known ? (saveState.phase === "saving" ? "Saving…" : saveState.phase === "failed" ? "Save failed" : "Saved") : null}
          editingFrozen={editingFrozen}
          onUndo={() => runUndoRedo("undo")}
          onRedo={() => runUndoRedo("redo")}
          onOpenDeckSpace={onOpenDeckSpace}
          exportOpen={exportOpen}
          onExportToggle={() => setExportOpen((open) => !open)}
          onExportClose={() => setExportOpen(false)}
          onExportPick={(format) => void handleExportPick(format)}
          exportState={exportState}
          onExportDismiss={() => setExportState({ kind: "idle" })}
          onPlay={() => void controllerRef.current?.play()}
          onPlayFromStart={() => {
            void (async () => {
              await controllerRef.current?.showSlide(0);
              await controllerRef.current?.play();
            })();
          }}
          canPlay={hasSlides}
        />
      )}
      {shellVisible && (
        <div className="app-notices">
          {liveReloadError && (
            <div role="alert" className="live-reload-banner">
              Live preview stopped: {liveReloadError} — reload the page
            </div>
          )}
          {presentationError && (
            <div role="alert" className="live-reload-banner">
              Deck info failed to load: {presentationError}
            </div>
          )}
          {canvasState.error && (
            <div role="alert" className="live-reload-banner canvas-error-banner">
              {canvasState.error}
            </div>
          )}
          {editingFrozen && (
            <div className="live-reload-banner editing-frozen-banner">Agent editing · undo/redo paused</div>
          )}
          {saveState.known && saveState.phase === "failed" && (
            <div role="alert" className="live-reload-banner save-failed-banner">
              {saveState.reason ?? "Save failed"}
              <button type="button" className="save-retry-button" onClick={() => void flushSave()}>
                Retry
              </button>
            </div>
          )}
          {openError && (
            <div role="alert" className="live-reload-banner">
              {openError}
            </div>
          )}
        </div>
      )}
      <div className="body">
        {shellVisible && (
          <Rail
            containerRef={overviewRef}
            slideCount={canvasState.slides.length}
            slides={canvasState.slides}
            currentIndex={canvasState.currentIndex}
            runCommand={runCanvasCommand}
            runPageCommand={runPageCommand}
            contextMenuRequest={contextMenuRequest}
            onCloseContextMenu={() => setContextMenuRequest(null)}
            onDraftWithAgent={(outline) => void draftWithAgent(outline)}
            pageSource={canvasState.pageSource}
            editingFrozen={editingFrozen}
            onEnterMasterMode={() => void enterMasterMode()}
            onExitMasterMode={() => void exitMasterMode()}
            onApplyTemplateToSlides={(templateName) => void applyTemplateToSlides(templateName)}
            userBlock={userBlock}
          />
        )}
        <div className="main">
          <Stage
            canvasRef={canvasRef}
            wellRef={wellRef}
            canvasSize={presentationInfo?.canvas ?? null}
            state={canvasState}
            controller={controllerRef.current}
            onEditAnimation={editSelectionAnimation}
            onEditStyle={editSelectionStyle}
            side={side}
            dropOverlay={{
              active: dropActive,
              onDragOver: handleStageDragOver,
              onDrop: handleStageDrop,
              onDragLeave: handleStageDragLeave,
            }}
            comment={{
              pin: resolvePinForSelection(),
              target: commentComposerTarget,
              editingCommentId: commentEditingId,
              draft: commentDraft,
              onDraftChange: setCommentDraft,
              onOpenForSelection: openCommentForSelection,
              onSubmit: () => void submitComment(),
              onDelete: () => void deleteOpenComment(),
              onClose: closeCommentComposer,
            }}
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
          {shellVisible && (
            <Notes
              slideNumber={hasSlides ? canvasState.currentIndex + 1 : null}
              slidePath={currentSlidePath()}
              onCommand={runCanvasCommand}
            />
          )}
        </div>
        {shellVisible && (
          <SidePanel
            state={canvasState}
            controller={controllerRef.current}
            canvasSize={presentationInfo?.canvas ?? null}
            side={side}
            sub={sub}
            onSideChange={setSide}
            onSubChange={setSub}
            chat={
              <ChatPanel
                messages={messages}
                working={working}
                streamReady={streamReady}
                draft={draft}
                onDraftChange={setDraft}
                onSubmit={() => void sendMessage()}
                onStop={() => void stopChatTurn()}
                stopping={stopping}
                onNewSession={() => void startNewChatSession()}
                picker={{
                  agentConnection,
                  probing: agentProbing,
                  editingFrozen,
                  switchingKind: agentSwitchingKind,
                  actionError: agentActionError,
                  onSelectAgent: (kind) => void handleSelectAgent(kind),
                  onProbe: () => void handleProbeAgent(),
                  modelOptions: agentModelOptions,
                  modelId: agentModelId,
                  modelsLocked: working || stopping,
                  onSelectModel: (modelId) => void selectAgentModel(modelId),
                  onLoadModels: () => void loadAgentModels(),
                  writeIsolation,
                }}
                comments={comments}
                onPinnedClick={(comment) => void openPinnedComment(comment)}
                onPinnedRemove={(commentId) => {
                  const comment = comments.find((c) => c.id === commentId);
                  if (comment) void deletePinnedComment(comment);
                }}
                commands={commands}
                agent={agentStatus}
              />
            }
          />
        )}
      </div>
      {shellVisible && <StatusBar state={canvasState} controller={controllerRef.current} />}
    </div>
  );
}
