// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import type { WorkbenchPolicy } from "./types.js";

/**
 * The open edition's policy — the one `WorkbenchPolicy` value this whole
 * repository ships with `cli.ts` selecting it. This module (and `cli.ts`,
 * which imports it) is deliberately the *only* place in `src/**` allowed to
 * name an edition (AC1, `#399` arch 1) — every other module receives a
 * `WorkbenchPolicy` as a parameter and must work unchanged if a different
 * one is substituted. `test/sandbox/derive.test.ts`'s grep guard enforces
 * this mechanically, not just by convention.
 *
 * The values below reproduce today's behaviour exactly (the open edition
 * must not regress on this change, "既有測試斷言一字不改" — a closed
 * policy that behaves differently is a separate, later module, not a
 * branch in this one).
 */
export const openPolicy: WorkbenchPolicy = {
  label: "open",
  network: { outbound: "unrestricted" },
  fileEntry: { uploadBytes: true, remoteUrl: true, localPath: false },
  mcp: { servers: [] },
  filesystem: {
    allowWrite: [
      { kind: "workbenchRoot" },
      { kind: "tempDir" },
      // macOS-only alias for the same temp directory Landlock/srt see under
      // a different name there (NOOP-425).
      { kind: "literal", path: "/private/tmp", onlyOn: "darwin" },
      // Every bundled adapter's own session state and token refresh (AC4),
      // now data-driven from each `AdapterSpec.writeRules`
      // (agent/adapters.ts) rather than named here (E10.T6/#400).
      { kind: "adapterState" },
      // npm/pip/uv/playwright caches: read-only here would make those tools
      // hard-fail rather than merely run uncached.
      { kind: "homeEntry", segments: [".npm"] },
      // `uv` always uses `~/.cache/uv` (XDG-style) even on macOS, ignoring
      // the platform's `~/Library/Caches` convention — grant both there.
      { kind: "homeEntry", segments: ["Library", "Caches"], onlyOn: "darwin" },
      { kind: "homeEntry", segments: [".cache"] },
      // gh and other CLIs' token refresh.
      { kind: "homeEntry", segments: [".config"] },
      // `cmd > /dev/null 2>&1` is one of the most common shell idioms
      // there is; without this, Landlock's write restriction (opening
      // /dev/null for writing is still a write) breaks it with EACCES.
      { kind: "literal", path: "/dev/null" },
    ],
    denyWrite: [],
    denyRead: [{ kind: "slidraHome" }, { kind: "openDeckPaths" }, { kind: "deckFolderIfPresent" }],
    cliAllowWrite: [{ kind: "slidraHome" }, { kind: "tempDir" }],
  },
};
