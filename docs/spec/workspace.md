# Slidra workspace specification

This document specifies the local runtime workspace outside a `.slidra` deck. It is not part of the portable deck format; for the deck container, use [the `.slidra` format specification](slidra-format.md). The CLI command surface is specified in [the CLI specification](cli.md).

## `SLIDRA_HOME`

`SLIDRA_HOME` selects the workspace root. If it is unset, Slidra uses `~/.slidra`. The environment variable is re-read on every invocation and is never cached, so test processes can point it at a temporary directory.

```
<SLIDRA_HOME>/
├── projects.json              # registry file
├── locks/<hash>.lock          # per-deck advisory lock, keyed by canonical deck path
└── clipboard/<id>.json        # one internal clipboard per presentation
```

A presentation id resolves to the `.slidra` deck file itself — there is no separate unpacked work directory any more (see [the `.slidra` format specification](slidra-format.md)). These three locations are the complete local-state contract: `projects.json`, `locks/<hash>.lock`, and `clipboard/<id>.json`. Undo/redo history is no longer part of this contract — it lives inside the deck file itself (see [the `.slidra` format specification](slidra-format.md)), so `<SLIDRA_HOME>/history/` is never created.

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

## Undo/redo history

Undo/redo history is stored in three tables inside the presentation's own `.slidra` deck file, alongside its `content` table — never under `SLIDRA_HOME`. Copying the deck file therefore carries its undo history with it, and reopening a deck on another machine restores it exactly. See [the `.slidra` format specification](slidra-format.md) for the table shapes and the undo/redo group caps.

## `clipboard/<id>.json`

Each presentation has an independent internal clipboard outside the deck file itself. Packing a deck never includes clipboard data. This one-file-per-presentation layout is the mechanism that restricts a paste without `--svg-file` to the presentation that supplied the copy.

## Deck folder

The deck folder is where the GUI's own deck lifecycle (create, import an external `.slidra`, list, rename, delete) reads and writes `.slidra` files — a location distinct from `SLIDRA_HOME` (which never holds deck content, only the registry, history, and clipboards).

Its path is `<SLIDRA_HOME>/settings.json`'s `deckFolder` key — the same file [`agent/settings.ts`](../../packages/server/src/agent/settings.ts) already owns for the agent selection, re-read fresh on every call, never cached. A missing key (or a missing file) defaults to `~/Slidra`. Any other value must be a non-empty string; an empty string, a wrong type, or a malformed settings file is reported as an explicit error, never silently patched into the default. This key is currently read-only — no command in this ticket's scope writes it.

The folder is created (`mkdir -p`) before every list/create/import, so a first run against a brand-new home lists as `[]` rather than erroring "not found". Changing `deckFolder` only changes where *subsequent* decks are created or imported into — a deck already on disk elsewhere is unaffected and keeps working through its existing registry entry.

Every deck file operation (create, import, rename, delete, and the `POST /api/open` upload path) goes through `packages/server/src/storage/`'s `DeckStore` — no other module calls `node:fs` against a `.slidra` file's own path.

A deck's `project.json` may additionally carry an `owner` field (a free-form string set at creation time, defaulting to `"Anonymous"` when not given explicitly, and only ever left absent for a deck predating this field). Unknown extra fields, `owner` included, always round-trip untouched (ADR-0003) — see [`slidra-format.md`](slidra-format.md).
