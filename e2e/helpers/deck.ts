// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

/**
 * Test-only direct reads of a deck's `content` table
 * (`crates/slidra/src/deck.rs`'s schema) — the SQLite-backed equivalent of
 * the deleted-work-directory era's `readdir`/`readFile` on a presentation's
 * real path. Used only by e2e tests that need to inspect a deck's raw
 * content directly (byte-for-byte round-trip comparisons, reading a slide
 * a running server has not been asked to serve) — the server and CLI
 * themselves never read a deck this way (decision 9: only the CLI writes
 * content). `node:sqlite` is experimental in this Node version but
 * read-only here, exactly like `packages/server/test/serve.test.ts`'s own
 * equivalent helpers.
 */

/** Every file's virtual path in the deck, sorted. */
export async function listDeckFiles(deckPath: string): Promise<string[]> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(deckPath, { readOnly: true });
  try {
    const rows = db.prepare("SELECT path FROM content WHERE kind = 0 ORDER BY path").all() as Array<{
      path: string;
    }>;
    return rows.map((row) => row.path);
  } finally {
    db.close();
  }
}

/** One file's raw bytes, by virtual path. Throws if no such file exists. */
export async function readDeckFileBytes(deckPath: string, virtualPath: string): Promise<Buffer> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(deckPath, { readOnly: true });
  try {
    const row = db.prepare("SELECT data FROM content WHERE path = ? AND kind = 0").get(virtualPath) as
      | { data: Uint8Array }
      | undefined;
    if (!row) throw new Error(`no such content row: ${virtualPath}`);
    return Buffer.from(row.data);
  } finally {
    db.close();
  }
}

/** One file's content, decoded as UTF-8 text. */
export async function readDeckFileText(deckPath: string, virtualPath: string): Promise<string> {
  return (await readDeckFileBytes(deckPath, virtualPath)).toString("utf-8");
}

/**
 * Overwrites one existing file's content directly — bypassing the CLI on
 * purpose, for a test fixture that needs a slide's raw bytes to NOT be
 * whatever `slide add`/`textbox add`/etc. would produce (e.g. a bare SVG
 * primitive not yet wrapped in a compliant `<g id="el-…">` container, to
 * set up a `convert` test). Never a stand-in for the server's or CLI's own
 * write path (decision 9).
 */
export async function writeDeckFileText(deckPath: string, virtualPath: string, content: string): Promise<void> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(deckPath);
  try {
    db.prepare("UPDATE content SET data = ? WHERE path = ? AND kind = 0").run(
      Buffer.from(content, "utf-8"),
      virtualPath,
    );
  } finally {
    db.close();
  }
}
