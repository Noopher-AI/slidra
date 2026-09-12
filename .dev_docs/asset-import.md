## Asset import

`asset import` copies (local source) or downloads (URL source) an image, video, or audio file into the
deck's `assets/` directory. It always validates by header bytes — see ADR-0015.

### Sources

- **Local absolute path**: reads the file directly.
- **URL** (`http://` or `https://`): downloads the response body. The `Content-Type` header is only a
  hint and is never used to determine format (it's untrusted input).

### Format validation: header bytes only, never the file extension

On import, the file's leading bytes are read and matched against the signatures of supported formats
(see the table below). **The file extension plays no part in format determination**:

- Extension spoofing (e.g. renaming a text file to `.png`): the header doesn't match any known
  signature, so it's rejected outright — no file is added to `assets/`.
- Extension is missing or wrong, but the content is genuinely a supported media type: the extension
  written to disk is decided by the detected real format, not by the source's extension.
- The URL response's `Content-Type` disagrees with the detected bytes: the byte-detection result always
  wins. If `Content-Type` claims media but the bytes don't back it up, it's rejected outright.

The single source of truth for the list of supported formats is `crates/slidra/src/media_format.rs`
(byte-signature detection — where `asset import` actually runs). `packages/server/src/media-types.ts` is
an extension/MIME lookup table maintained in sync with it; `packages/server/src/raw.ts`, which supplies
the Content-Type used when the browser reads assets from `/api/raw/`, derives its table from that same
lookup table rather than maintaining a third copy.

| Extension | MIME type | Kind |
|---|---|---|
| `.png` | image/png | image |
| `.jpg` (incl. `.jpeg`) | image/jpeg | image |
| `.gif` | image/gif | image |
| `.webp` | image/webp | image |
| `.mp4` | video/mp4 | video |
| `.webm` | video/webm | video |
| `.m4v` | video/mp4 | video |
| `.mov` | video/quicktime | video |
| `.ogv` | video/ogg | video |
| `.mp3` | audio/mpeg | audio |
| `.wav` | audio/wav | audio |
| `.m4a` | audio/mp4 | audio |
| `.opus` | audio/ogg | audio |
| `.oga` | audio/ogg | audio |
| `.aac` | audio/aac | audio |

### Filename collision rule

Destination filename = (source filename with extension stripped, illegal filesystem characters replaced
with `_`) + (extension decided by the detected format).

If `assets/<name><ext>` already exists, `<name>-1<ext>`, `<name>-2<ext>`, ... are tried in order until
the first name that doesn't exist yet is found. **Existing files are never overwritten, and timestamps
are never used** — timestamps can't be asserted reliably in tests and make eyeballing filenames harder
when debugging.

### Undo/redo

An import is its own independent undo step: `slidra undo` removes the just-imported file from
`assets/`; `slidra redo` writes its original bytes back byte-for-byte. It shares the same undo/redo
stack as every other write command — there is no separate recovery logic specific to asset import.
