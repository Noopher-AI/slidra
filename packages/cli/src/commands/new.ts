import { createNewPresentation } from "@co-motion/core";
import type { CommandHandler } from "../registry.js";

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
    message: `已建立簡報：${input.path}`,
  };
};
