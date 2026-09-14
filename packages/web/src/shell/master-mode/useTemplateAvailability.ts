// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { useEffect, useState } from "react";

type RunCommand = (
  name: string,
  input: Record<string, unknown>,
) => Promise<{ ok: boolean; message: string; data?: unknown } | undefined>;

/**
 * Whether the deck has at least one template — drives the master-mode
 * toggle's disabled state (behavior contract: visible but disabled with no
 * templates, never a hidden button and never an entry into an empty mode).
 * Deliberately its own minimal fetch rather than reusing
 * `rail/useTemplateList.ts` (off-limits to edit — T3 plan's own "不得修改"):
 * that hook fetches once per mount and is only ever mounted while its own
 * floating menu is open, so it can never notice a template created a
 * moment ago by "Save as template". This one takes an explicit
 * `refreshKey` so the one caller that can add a template forces a re-check.
 */
export function useTemplateAvailability(runCommand: RunCommand, refreshKey: number): boolean {
  const [hasTemplates, setHasTemplates] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Rail mounts (and this effect fires) as App's child, before App's own
    // effect has run `mountCanvas`/wired up `runCanvasCommand` — this
    // component's very first check otherwise always sees `runCommand`
    // resolve `undefined` (no controller yet) and would report "no
    // templates" forever. Retried for up to a second (20×50ms) rather than
    // depending on some other prop's timing to know when the controller is
    // ready — every other value on `CanvasState` is just as capable of
    // lagging behind app-level effect ordering as this one.
    async function check(attemptsLeft: number): Promise<void> {
      const result = await runCommand("template list", {});
      if (cancelled) return;
      if (result === undefined && attemptsLeft > 0) {
        setTimeout(() => void check(attemptsLeft - 1), 50);
        return;
      }
      const data = result?.ok ? (result.data as { templates?: unknown[] } | undefined) : undefined;
      setHasTemplates(Array.isArray(data?.templates) && data.templates.length > 0);
    }
    void check(20);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  return hasTemplates;
}
