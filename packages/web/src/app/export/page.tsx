// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

"use client";

import { useEffect, useRef } from "react";
import { runExport } from "../../export-entry.js";

export default function ExportPage() {
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void runExport().catch((error: unknown) => {
      window.__SLIDRA_EXPORT_ERROR__ = error instanceof Error ? error.message : String(error);
    });
  }, []);

  return null;
}
