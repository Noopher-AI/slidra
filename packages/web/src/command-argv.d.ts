/**
 * `POST /api/command`'s input→argv encoder (plan §3.9) — the reverse of
 * `packages/cli/src/argv.ts`'s `parseArgv` (argv→input), needed because
 * the front end sends a structured `input` object but the Rust binary only
 * takes argv. Every case here was written by opening `argv.ts`'s matching
 * `case` and copying its field names verbatim (§3.9's own instruction) —
 * `argv.ts` is the one authoritative source for what each command's input
 * shape is, since it already has to produce exactly the shape the shared
 * command handlers expect.
 *
 * `--json` is never appended here — `runJsonCommand` (`command.ts`) always
 * adds it as the argv's last token (§3.4).
 */
export interface EncodedCommand {
    argv: string[];
    /** Optional stdin bytes for commands whose browser form uses `*-file -`. */
    body?: Uint8Array;
    cleanup: () => Promise<void>;
}
type ArgvEncoder = (input: Record<string, unknown>) => Promise<EncodedCommand> | EncodedCommand;
/**
 * The only commands `POST /api/command` will run. Each entry was added as
 * a given panel needed it, not as a convenience. Relocated here from
 * `command-endpoint.ts` ([E10.T5] Slice B — that module is deleted, its
 * dispatch now forwarded through `POST /call` instead) since this is
 * where its one remaining consumer, `serve.ts`'s command forwarder, and
 * its cross-check partner, `ARGV_ENCODERS` below, both already live.
 */
export declare const COMMAND_WHITELIST: readonly string[];
/**
 * Every `COMMAND_WHITELIST` entry's encoder, keyed by command name.
 * `encodeCommandArgv` (below) is the only way this map is read; a
 * unit test (`slidra.test.ts`) asserts `new Set(COMMAND_WHITELIST)`
 * equals `new Set(Object.keys(ARGV_ENCODERS))` — the two must never drift.
 */
export declare const ARGV_ENCODERS: Record<string, ArgvEncoder>;
/** Encodes one whitelisted command's structured `input` into argv (without `--json`). Throws if `name` has no encoder — never sends a partial/guessed argv (§4.2). */
export declare function encodeCommandArgv(name: string, input: Record<string, unknown>): Promise<EncodedCommand>;
export {};
