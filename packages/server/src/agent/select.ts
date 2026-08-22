import { CoMotionError } from "@co-motion/core";
import { ADAPTER_SPECS, adapterSpecFor, type AdapterSpec, type AgentKind } from "./adapters.js";

/**
 * Chooses which adapter `serve` will spawn on the first chat message, given
 * what detection found and what `--agent` (if anything) requested. Pure
 * decision logic, deliberately separate from `detect.ts`'s I/O so the whole
 * behaviour table (§3) is testable without touching the filesystem.
 *
 * No fallback: every branch either returns exactly one adapter or throws a
 * `CoMotionError` with Traditional-Chinese guidance. There is no "pick one
 * anyway" or "chat disabled but serve runs" path.
 */
export function selectAdapter(available: AdapterSpec[], requested: AgentKind | undefined): AdapterSpec {
  if (available.length === 0) {
    throw new CoMotionError(noAdapterInstalledMessage());
  }

  if (requested !== undefined) {
    const found = available.find((spec) => spec.kind === requested);
    if (!found) {
      const spec = adapterSpecFor(requested);
      throw new CoMotionError(
        `指定的 agent 尚未安裝：${spec.label}。請執行「npm install -g ${spec.npmPackage}」安裝後再試一次。`,
      );
    }
    return found;
  }

  if (available.length === 1) {
    return available[0];
  }

  const names = available.map((spec) => spec.kind).join("、");
  throw new CoMotionError(`偵測到多個可用的 agent（${names}），請用 --agent 指定要使用哪一個。`);
}

function noAdapterInstalledMessage(): string {
  const lines = ADAPTER_SPECS.map((spec) => `- ${spec.label}：npm install -g ${spec.npmPackage}`);
  return [
    "找不到任何可用的 agent，CoMotion 的聊天功能需要先安裝以下其中一個：",
    ...lines,
    "安裝完成後重新執行 co-motion serve。",
  ].join("\n");
}
