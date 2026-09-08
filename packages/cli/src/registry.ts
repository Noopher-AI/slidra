import { CoMotionError, CoMotionNotFoundError } from "@co-motion/core";

/**
 * Why a command failed, in the only distinction any caller is allowed to
 * act on: `"not-found"` means the thing asked for was positively proven
 * absent (a `CoMotionNotFoundError`); `"failed"` means anything else went
 * wrong — an I/O error, a corrupt registry, or an error subtype invented
 * after this line was written.
 *
 * This exists so callers never pattern-match on `message`. The messages
 * are human copy in Traditional Chinese and may be reworded at any time;
 * turning them into a contract would break classification silently the
 * first time someone improves the wording (ticket #14).
 */
export type CommandFailureKind = "not-found" | "failed";

/**
 * The outcome of running one command. This is the only thing a handler ever
 * returns — never process.stdout, never process.exit. Both the one-shot CLI
 * and the future `co-motion serve` dispatch consume this same shape
 * (ADR-0002).
 */
export interface CommandResult<Data = unknown> {
  ok: boolean;
  /** Structured payload for successful commands. */
  data?: Data;
  /** Traditional-Chinese, human-readable summary. Never contains a real filesystem path. */
  message: string;
  /**
   * Set by `dispatch` on every failure it converts, and absent on success.
   * It is optional rather than required-when-failed so a handler can keep
   * returning a bare `{ ok: false, message }`; a caller that maps this onto
   * an HTTP status must therefore read a missing value as "not proven
   * absent" and answer 500, never 404 (see `/api/files/` in serve.ts).
   */
  failureKind?: CommandFailureKind;
}

/**
 * A command handler takes already-parsed, structured input and returns a
 * structured result. It must not read process.argv, write to
 * process.stdout/stderr, or call process.exit.
 */
export type CommandHandler<Input = unknown, Data = unknown> = (
  input: Input,
) => Promise<CommandResult<Data>> | CommandResult<Data>;

/**
 * Turns a successful command's structured `data` into the exact bytes a
 * terminal should see (e.g. `cat`'s raw file content, `ls`'s bare entry
 * list). Only the CLI bin layer calls this — `co-motion serve` consumes
 * `data` directly and never touches renderers.
 */
export type TerminalRenderer<Data = unknown> = (data: Data) => string;

/**
 * What gets registered for a command: its handler plus an explicit
 * decision about terminal rendering. `render` is required (not optional)
 * so a command cannot be registered without its author confronting the
 * question — `null` means "no bespoke rendering, use the default
 * status-line-plus-JSON output".
 */
export interface CommandDefinition<Input = unknown, Data = unknown> {
  handler: CommandHandler<Input, Data>;
  render: TerminalRenderer<Data> | null;
}

export class UnknownCommandError extends Error {
  constructor(name: string) {
    super(`未知的命令：${name}`);
    this.name = "UnknownCommandError";
  }
}

/**
 * Maps command names to handlers. This registry is the single dispatch
 * surface shared by the one-shot `co-motion` bin and, later, `co-motion serve`.
 */
export class CommandRegistry {
  private readonly definitions = new Map<string, CommandDefinition<any, any>>();

  register<Input, Data>(name: string, definition: CommandDefinition<Input, Data>): void {
    if (this.definitions.has(name)) {
      throw new Error(`Command already registered: ${name}`);
    }
    this.definitions.set(name, definition);
  }

  /**
   * Dispatches a command by name with structured input. Expected failures
   * (CoMotionError) are converted into a `{ ok: false }` result carrying a
   * `failureKind` so the error's subtype survives this boundary; anything
   * else propagates as a thrown error (a bug, not a user-facing failure).
   *
   * Returns only the structured `CommandResult` — never anything
   * rendering-related. This is the method `co-motion serve` calls.
   */
  async dispatch<Data = unknown>(name: string, input: unknown): Promise<CommandResult<Data>> {
    const definition = this.definitions.get(name);
    if (!definition) {
      throw new UnknownCommandError(name);
    }
    try {
      return (await definition.handler(input)) as CommandResult<Data>;
    } catch (error) {
      // Order matters: CoMotionNotFoundError is a CoMotionError, and it is
      // the narrow case that must be checked first. Only it earns
      // "not-found" — every other CoMotionError, including subtypes added
      // later that this code has never heard of, is "failed", because
      // "not an instance of CoMotionNotFoundError" is not evidence that
      // anything is absent (ticket #11's classification, ticket #14).
      if (error instanceof CoMotionNotFoundError) {
        return { ok: false, message: error.message, failureKind: "not-found" };
      }
      if (error instanceof CoMotionError) {
        return { ok: false, message: error.message, failureKind: "failed" };
      }
      throw error;
    }
  }

  has(name: string): boolean {
    return this.definitions.has(name);
  }

  /**
   * Every registered command name, in registration order. The only public
   * way to enumerate the registry — added so `reference/commands.md` (a
   * hand-written document, not generated: `CommandDefinition` carries no
   * parameter/purpose metadata to generate from) can be checked against it
   * for coverage, without a test reaching for the private `definitions` map
   * the way `packages/cli/test/registry-split.test.ts` already does.
   */
  names(): string[] {
    return [...this.definitions.keys()];
  }

  /**
   * Looks up a command's terminal renderer, if any. Used only by the CLI
   * bin layer to decide how to print a successful result.
   */
  getRenderer<Data = unknown>(name: string): TerminalRenderer<Data> | undefined {
    const definition = this.definitions.get(name);
    if (!definition || definition.render === null) {
      return undefined;
    }
    return definition.render as TerminalRenderer<Data>;
  }
}
