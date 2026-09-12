// Copyright 2026 Noopher AI
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from "react";

export interface TemplateEntry {
  file: string;
  name: string;
}

export type TemplateListState =
  | { status: "loading" }
  | { status: "ready"; templates: TemplateEntry[] }
  | { status: "error"; message: string };

type RunCommand = (
  name: string,
  input: Record<string, unknown>,
) => Promise<{ ok: boolean; message: string; data?: unknown } | undefined>;

/**
 * Fetches `template list` once on mount — shared by `NewMenu` and
 * `TemplatesMenu` (T3 plan §4.4) so both read the same live data instead
 * of each carrying its own copy of the fetch/loading/error dance. Each
 * caller only ever mounts this while its own floating layer is open (React
 * unmounts it on close), so there is no `active` flag to gate on — mount
 * IS "just opened".
 */
export function useTemplateList(runCommand: RunCommand): TemplateListState {
  const [state, setState] = useState<TemplateListState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    void runCommand("template list", {}).then((result) => {
      if (cancelled) return;
      if (result?.ok) {
        const data = result.data as { templates?: unknown } | undefined;
        const templates = Array.isArray(data?.templates) ? (data.templates as TemplateEntry[]) : [];
        setState({ status: "ready", templates });
      } else {
        setState({ status: "error", message: result?.message ?? "Failed to load template list" });
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return state;
}
