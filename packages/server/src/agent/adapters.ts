/**
 * The two ACP adapters CoMotion knows how to drive. Claude Code and Codex
 * are not themselves ACP servers — each needs its own thin adapter
 * executable that speaks ACP over stdio and drives the underlying CLI. This
 * is why detection and spawning both target the adapter's command name, not
 * `claude` or `codex`.
 */
export type AgentKind = "claude" | "codex";

export interface AdapterSpec {
  kind: AgentKind;
  /** Human-readable name used in status and error messages. */
  label: string;
  /** Adapter executable name, looked up on PATH — never the underlying CLI. */
  command: string;
  /** npm package that installs `command`, named in install guidance. */
  npmPackage: string;
}

export const ADAPTER_SPECS: readonly AdapterSpec[] = [
  {
    kind: "claude",
    label: "Claude Code",
    command: "claude-code-acp",
    npmPackage: "@zed-industries/claude-code-acp",
  },
  {
    kind: "codex",
    label: "Codex",
    command: "codex-acp",
    npmPackage: "@zed-industries/codex-acp",
  },
];

export function adapterSpecFor(kind: AgentKind): AdapterSpec {
  const spec = ADAPTER_SPECS.find((candidate) => candidate.kind === kind);
  if (!spec) {
    // Unreachable given AgentKind's two literal values — a thrown error
    // here would mean the type and this table have drifted apart.
    throw new Error(`no adapter spec for kind: ${kind}`);
  }
  return spec;
}
