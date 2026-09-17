# Slidra workspace specification

This document specifies the local runtime workspace outside a `.slidra` deck. It is not part of the portable deck format; for the deck container, use [the `.slidra` format specification](slidra-format.md). The CLI command surface is specified in [the CLI specification](cli.md).

## `SLIDRA_HOME`

`SLIDRA_HOME` selects the workspace root. If it is unset, Slidra uses `~/.slidra`. The environment variable is re-read on every invocation and is never cached, so test processes can point it at a temporary directory.

```
<SLIDRA_HOME>/
├── projects.json              # registry file
├── .projects.json.lock        # advisory lock guarding a projects.json read-modify-write
├── settings.json               # user-level settings (agent selection, deck folder)
├── locks/<hash>.lock          # per-deck advisory lock, keyed by canonical deck path
└── clipboard/<id>.json        # one internal clipboard per presentation
```

A presentation id resolves to the `.slidra` deck file itself — there is no separate unpacked work directory any more (see [the `.slidra` format specification](slidra-format.md)). These five locations are the complete local-state contract: `projects.json`, `.projects.json.lock`, `settings.json`, `locks/<hash>.lock`, and `clipboard/<id>.json`. Undo/redo history is no longer part of this contract — it lives inside the deck file itself (see [the `.slidra` format specification](slidra-format.md)), so `<SLIDRA_HOME>/history/` is never created.

## `projects.json`

The registry is keyed by opaque presentation id. Each entry has this shape:

```ts
interface RegistryEntry {
  deckPath: string;      // the .slidra deck file this id resolves to
  sourcePath?: string;   // most recently opened source deck path
  savedAt?: number;      // the deck file's own mtime snapshot, not Date.now()
}
```

`savedAt` compares two filesystem `stat` readings taken in the same way; it is deliberately not a wall-clock timestamp. The registry is written to a temporary file in the same directory and atomically renamed over `projects.json`. Only a missing file is treated as an empty registry; malformed JSON, permission failures, and other I/O failures are reported explicitly. An entry written by a pre-upgrade release (`workDir` instead of `deckPath`) is dropped on read rather than treated as corrupt — its own id is already dead, since `work/<id>/` no longer exists — so it cannot take an unrelated `open`/`new` down with it.

A read-modify-write of `projects.json` is guarded by an advisory lock file at `<SLIDRA_HOME>/.projects.json.lock` — the same path name in both the Rust crate (`workspace::registry_lock_path`) and the TypeScript server (`registryLockPath` in [`slidra/home.ts`](../../packages/server/src/slidra/home.ts)); a lock only excludes a concurrent writer if every writer agrees on its path.

## `settings.json`

`<SLIDRA_HOME>/settings.json` holds user-level settings that are not tied to any one presentation: the agent kind and per-agent model selection ([`agent/settings.ts`](../../packages/server/src/agent/settings.ts)), and the deck folder path (see "Deck folder" below). The file may carry other keys in the future; a reader that does not own a given key always preserves it byte-for-byte on write. A missing file is not an error — nothing has been chosen yet — and it is created lazily, only by the first write.

## Undo/redo history

Undo/redo history is stored in three tables inside the presentation's own `.slidra` deck file, alongside its `content` table — never under `SLIDRA_HOME`. Copying the deck file therefore carries its undo history with it, and reopening a deck on another machine restores it exactly. See [the `.slidra` format specification](slidra-format.md) for the table shapes and the undo/redo group caps.

## `clipboard/<id>.json`

Each presentation has an independent internal clipboard outside the deck file itself. Packing a deck never includes clipboard data. This one-file-per-presentation layout is the mechanism that restricts a paste without `--svg-file` to the presentation that supplied the copy.

## Deck folder

The deck folder is where the GUI's own deck lifecycle (create, import an external `.slidra`, list, rename, delete) reads and writes `.slidra` files — a location distinct from `SLIDRA_HOME` (which never holds deck content, only the registry, settings, locks, and clipboards; undo/redo history lives inside the deck file itself, see above).

Its path is `<SLIDRA_HOME>/settings.json`'s `deckFolder` key — the same file [`agent/settings.ts`](../../packages/server/src/agent/settings.ts) already owns for the agent selection, re-read fresh on every call, never cached. A missing key (or a missing file) defaults to `~/Slidra`. Any other value must be a non-empty string; an empty string, a wrong type, or a malformed settings file is reported as an explicit error, never silently patched into the default. This key is currently read-only — no command in this ticket's scope writes it.

The folder is created (`mkdir -p`) before every list/create/import, so a first run against a brand-new home lists as `[]` rather than erroring "not found". Changing `deckFolder` only changes where *subsequent* decks are created or imported into — a deck already on disk elsewhere is unaffected and keeps working through its existing registry entry.

Every deck file operation (create, import, rename, delete, and the `POST /api/open` upload path) goes through `packages/server/src/storage/`'s `DeckStore` — no other module calls `node:fs` against a `.slidra` file's own path.

A deck's `project.json` may additionally carry an `owner` field (a free-form string set at creation time, defaulting to `"Anonymous"` when not given explicitly, and only ever left absent for a deck predating this field, or one only ever registered in place from a file already sitting in the deck folder). Unknown extra fields, `owner` included, always round-trip untouched (ADR-0011) — see [`slidra-format.md`](slidra-format.md). A missing `owner` (`null`) is treated as anonymous everywhere a literal `"Anonymous"` tag is: visible with no identity signed in, and claimed the same way on sign-in (ADR-0012's extension).

## Agent working directory ([E6.T8], `SandboxRoot`)

The agent's deployed work directory is **not** under `SLIDRA_HOME`. Each `slidra serve` process creates its own scratch tree at `<os.tmpdir()>/slidra-sandbox-<per-serve uuid>/` (`SandboxRoot`, [`sandbox/sandbox-root.ts`](../../packages/server/src/sandbox/sandbox-root.ts)) and deploys one presentation's work directory under `<root>/<presentationId>`, alongside a shared shim wrapper at `<root>/bin/slidra`. This replaced the earlier `<SLIDRA_HOME>/agent` location: a per-serve root means two `slidra serve` processes on one machine cannot collide, since each gets its own empty root rather than sharing — and retiring one, whether one presentation via `disposePresentation` or the whole root on shutdown via `disposeAll`, never touches `SLIDRA_HOME`. See ADR-0004 for why this directory is also where the OS-level agent sandbox's write allow-list is anchored.

Conversation history does not live in this directory either — see "Undo/redo history" above and [`slidra-format.md`](slidra-format.md) §1.4 for `chat_history`: it persists inside the deck file, so switching or restarting the agent reads it back from there, not from any per-serve scratch state.
