import { setSlideParagraphList, type ListKind } from "@co-motion/core";
import type { CommandHandler, CommandRegistry } from "../registry.js";

/**
 * `co-motion text list set` (NOOP-65 §4.3). Sets one paragraph's list kind
 * (`bullet` | `number` | `none`) — the paragraph index is 0-based over the
 * text box's content string split on `"\n"`.
 */
export interface TextListSetInput {
  id: string;
  /** Virtual path, e.g. "slides/001.svg". */
  slidePath: string;
  elementId: string;
  paragraph: number;
  kind: ListKind;
  /** Bypasses the locked-element guard (T3, ADR-0013). Never sent by the front end. */
  force?: boolean;
}

export interface TextListSetData {
  paragraphs: number;
}

export const textListSetCommand: CommandHandler<TextListSetInput, TextListSetData> = async (input) => {
  const { paragraphs } = await setSlideParagraphList(
    input.id,
    input.slidePath,
    input.elementId,
    input.paragraph,
    input.kind,
    { force: input.force },
  );
  return {
    ok: true,
    data: { paragraphs },
    message: `已將 ${input.elementId} 第 ${input.paragraph} 段設為 ${input.kind}`,
  };
};

export function register(registry: CommandRegistry): void {
  registry.register("text list set", { handler: textListSetCommand, render: null });
}
