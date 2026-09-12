# Agents may import assets from an absolute path or a URL, but only genuine media is accepted

> **This ADR opens an explicit hole in the "only genuine media" guardrail, for tables.** Everything below (including the "only genuine media" rule itself) is completely unchanged when `--as` isn't passed — see "`--as csv`: data assets" at the end.

> **This ADR opens an explicit hole in the isolation established by ADR-0004.** That ADR's entire argument was "don't let an agent touch the real filesystem," and the second of its three layers of protection was "the permission hook only allows `slidra *`." A `slidra` command that accepts an absolute path is exactly the thing that hook was meant to block, and this bypasses it. The rest of ADR-0004 (the virtual file structure, `fs/write_text_file` always refused, real paths never leaked, SVG must stay lean) is completely unaffected.

If a user says "put a photo of our office building on this page" and the agent has no way to bring in a file at all, the only answer it can give is "please drag it in yourself." For a tool built around people and agents editing together, that's too weak an answer.

So an asset-import command is added, whose **source can be a local absolute path or a URL**, always copied or downloaded into the `.slidra`'s `assets/` — the only place assets live, so a presentation still plays offline with no broken external links.

## Guardrail: validate genuine media on import

The file's leading bytes are read to confirm it's actually an image or audio/video file — **the extension is never trusted**. Anything that isn't a supported media format is rejected.

This shuts down the worst case: `asset import ~/.ssh/id_rsa` fails outright. Text files, keys, and config files can't get in this way. Normal usage is completely unaffected — what's being added was always going to be an image or a video anyway.

This check is useful for people too: dragging in an unsupported format gets an immediate "this format isn't supported," instead of a broken image appearing on the slide. Throw an error, never fall back to something else.

## Considered Options

- **Agents can't bring in new assets at all**, limited to what's already in `assets/` or vector graphics it draws itself: ADR-0004's isolation stays completely intact, no hole needed. The cost is that "find me a photo and put it on the slide" simply can't be done.
- **Import only from a designated inbox folder**: the agent gets a capability with a bounded scope, and whatever the user puts there is implicitly authorized. But the user still has to move the file themselves — compared to just dragging it into the editor, this saves one step at the cost of introducing a whole new concept to explain.

## Consequences

- **This command passes the permission hook**, because it's a `slidra` command. Format validation is the only guard left on this path, and it must sit in front of any write into `assets/`.
- **A list of supported formats is required**, and it needs to be the same list the player recognizes — the player already has to know what it can play.
- **Importing from a URL means the app makes an outbound network request**, with the source determined by presentation content or the conversation. ADR-0010 already treats slide content as untrusted, so this path must never be used to read anything beyond the response's media content, and must not follow a non-media response.
- Filename collisions need an explicit rule, rather than silently overwriting an existing asset.
- The path for a person stays the same: drag a file into the editor, or paste an image from the system clipboard — both go through the same import and validation.

## `--as csv`: data assets

Table data binding (`table bind`) needs to bring a CSV file into the presentation, and CSV is a text file — exactly what "only genuine media" is meant to block. Rather than opening a quiet hole in the existing media-import path, this is an **explicit, opt-in** bypass:

```
slidra asset import <presentation-id> ./sales.csv --as csv
```

Without `--as`, `asset import`'s behavior is unchanged from what this ADR originally describes at the byte level — `resolveAssetImport` is completely unaffected, still "read the leading bytes to confirm it's image/audio/video, error if not." `--as csv` is an entirely separate validation-and-write path (`resolveDataAssetImport`), gated by three guardrails, all required:

1. **The source filename must end in `.csv`** (case-insensitive) — content isn't sniffed to guess this.
2. **Content must be valid UTF-8**, and must not contain a NUL byte or any control character other than `\t`/`\r`/`\n` — CSV is still text, not arbitrary bytes.
3. **Content must parse as valid tabular CSV** (RFC 4180, headers non-empty and non-duplicated, consistent column count per row), and headers must not collide with the reserved dynamic-text placeholders (`slide_number`/`slide_total`/`presentation_name`).

If any of the three fails, **nothing is written** — consistent with the media-import posture of "throw an error, never fall back." The write path is fixed at `assets/data/`, in a separate subdirectory from general media in `assets/`, with its own independent filename-collision rule (`sales.csv` colliding becomes `sales-1.csv`, and never collides with a same-named media file elsewhere under `assets/`).

`~/.ssh/id_rsa --as csv` still gets blocked at guardrail 2 (valid UTF-8) or guardrail 3 (valid CSV structure) — this hole only lets through text that genuinely looks like tabular data, not arbitrary text files.
