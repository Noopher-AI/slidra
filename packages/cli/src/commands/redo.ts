import { redoLastGroup } from "@co-motion/core";
import type { CommandHandler, CommandRegistry } from "../registry.js";

export interface RedoInput {
  id: string;
}

export interface RedoData {
  restoredPaths: string[];
}

export const redoCommand: CommandHandler<RedoInput, RedoData> = async (input) => {
  const { restoredPaths } = await redoLastGroup(input.id);
  return {
    ok: true,
    data: { restoredPaths },
    message: "已重做上一步操作",
  };
};

export function register(registry: CommandRegistry): void {
  registry.register("redo", { handler: redoCommand, render: null });
}
