import { undoLastGroup } from "@co-motion/core";
import type { CommandHandler, CommandRegistry } from "../registry.js";

export interface UndoInput {
  id: string;
}

export interface UndoData {
  restoredPaths: string[];
}

export const undoCommand: CommandHandler<UndoInput, UndoData> = async (input) => {
  const { restoredPaths } = await undoLastGroup(input.id);
  return {
    ok: true,
    data: { restoredPaths },
    message: "已復原上一步操作",
  };
};

export function register(registry: CommandRegistry): void {
  registry.register("undo", { handler: undoCommand, render: null });
}
