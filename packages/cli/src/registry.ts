import { CoMotionError } from "@co-motion/core";

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
}

/**
 * A command handler takes already-parsed, structured input and returns a
 * structured result. It must not read process.argv, write to
 * process.stdout/stderr, or call process.exit.
 */
export type CommandHandler<Input = unknown, Data = unknown> = (
  input: Input,
) => Promise<CommandResult<Data>> | CommandResult<Data>;

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
  private readonly handlers = new Map<string, CommandHandler<any, any>>();

  register<Input, Data>(name: string, handler: CommandHandler<Input, Data>): void {
    if (this.handlers.has(name)) {
      throw new Error(`Command already registered: ${name}`);
    }
    this.handlers.set(name, handler);
  }

  /**
   * Dispatches a command by name with structured input. Expected failures
   * (CoMotionError) are converted into a `{ ok: false }` result; anything
   * else propagates as a thrown error (a bug, not a user-facing failure).
   */
  async dispatch<Data = unknown>(name: string, input: unknown): Promise<CommandResult<Data>> {
    const handler = this.handlers.get(name);
    if (!handler) {
      throw new UnknownCommandError(name);
    }
    try {
      return (await handler(input)) as CommandResult<Data>;
    } catch (error) {
      if (error instanceof CoMotionError) {
        return { ok: false, message: error.message };
      }
      throw error;
    }
  }

  has(name: string): boolean {
    return this.handlers.has(name);
  }
}
