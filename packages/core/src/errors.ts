/**
 * A CoMotionError is an expected, user-facing failure: a bad container,
 * an unknown presentation id, a missing formatVersion, etc.
 *
 * It always carries a Traditional Chinese message safe to print verbatim —
 * in particular it must never contain a real filesystem path (ADR-0004).
 */
export class CoMotionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoMotionError";
  }
}

/**
 * A CoMotionError subtype for the one case that positively identifies the
 * requested thing as genuinely absent: a virtual path that does not
 * resolve to any node, a virtual path that resolves to something that is
 * not a file, or an unknown presentation id. Nothing else may throw this.
 *
 * Callers that need an HTTP-shaped answer (e.g. the `/api/raw/` route)
 * check for this subtype with `instanceof` and treat only it as 404 —
 * every other `CoMotionError`, including ones not yet invented, is a
 * server-side failure (500), because "not an instance of this type" is
 * not evidence that something is missing. This is the inverse of an
 * earlier design that tried to positively identify I/O failures instead:
 * that shape meant every new error kind defaulted to 404 unless someone
 * remembered to carve out an exception, which is how three prior rounds
 * of this ticket each fixed one more mistaken 404. Making "genuinely
 * absent" the thing that must be positively proven means a new error kind
 * defaults to a loud 500 instead of a silently wrong 404.
 */
export class CoMotionNotFoundError extends CoMotionError {
  constructor(message: string) {
    super(message);
    this.name = "CoMotionNotFoundError";
  }
}

/**
 * A CoMotionError subtype for the one failure that happens *after* the new
 * `stack.json` is already durable on disk (#85 W3-R12): committing an undo
 * group writes the stack first and only then unlinks the snapshot files
 * nothing references any more, so a failure in that unlink loop means the
 * commit itself SUCCEEDED and merely leaked an unreferenced snapshot file.
 *
 * A multi-file caller (`applyPresentationChanges`) must not compensate in
 * that case: the persisted stack already references the staged snapshots,
 * so reverting the files and discarding those snapshots would corrupt undo
 * permanently while telling the author the change was reverted.
 *
 * It carries the same message as the plain failure it replaces, and it is
 * still a `CoMotionError` that is still thrown, so every single-file path
 * that does not catch it (`writePresentationFile` and its callers) behaves
 * exactly as before.
 */
export class CoMotionHistoryCleanupError extends CoMotionError {
  constructor(message: string) {
    super(message);
    this.name = "CoMotionHistoryCleanupError";
  }
}
