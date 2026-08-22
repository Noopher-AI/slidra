import { packPresentation } from "@co-motion/core";
import type { CommandHandler } from "../registry.js";

export interface PackInput {
  id: string;
  path: string;
}

export type PackData = Record<string, never>;

export const packCommand: CommandHandler<PackInput, PackData> = async (input) => {
  await packPresentation(input.id, input.path);
  return {
    ok: true,
    data: {},
    message: "已完成打包",
  };
};
