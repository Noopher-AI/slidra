import { createNewPresentation } from "@co-motion/core";
import type { CommandHandler, CommandRegistry } from "../registry.js";

export interface NewInput {
  path: string;
  name?: string;
}

export type NewData = Record<string, never>;

export const newCommand: CommandHandler<NewInput, NewData> = async (input) => {
  const name = input.name ?? "新簡報";
  await createNewPresentation(input.path, name);
  return {
    ok: true,
    data: {},
    message: `已建立簡報「${name}」`,
  };
};

export function register(registry: CommandRegistry): void {
  registry.register("new", { handler: newCommand, render: null });
}
