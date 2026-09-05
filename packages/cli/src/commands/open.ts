import { openPresentation } from "@co-motion/core";
import type { CommandHandler, CommandRegistry } from "../registry.js";

export interface OpenInput {
  path: string;
}

export interface OpenData {
  id: string;
}

export const openCommand: CommandHandler<OpenInput, OpenData> = async (input) => {
  const { id } = await openPresentation(input.path);
  return {
    ok: true,
    data: { id },
    message: `已開啟簡報，識別碼：${id}`,
  };
};

export function register(registry: CommandRegistry): void {
  registry.register("open", { handler: openCommand, render: null });
}
