// Copyright 2026 Noopher AI
// SPDX-License-Identifier: Apache-2.0

"use client";

import { App } from "../App.js";
// Tokens first: the regional styles reference --s-well/--ink/etc., so the
// root custom properties and bundled @font-face declarations must be parsed
// before their consumers. These stay on the editor route so export.html has
// the same unstyled document that the PDF renderer used before Next.js.
import "../styles/tokens.css";
import "../style.css";
import "../styles/shell.css";
import "../styles/stage.css";
import "../styles/stage-overlays.css";
import "../styles/dock.css";
import "../styles/rail.css";
import "../styles/plan-gate.css";
import "../styles/export-panel.css";
import "../styles/notes.css";
import "../styles/chat.css";
import "../styles/play.css";
import "../styles/selection.css";
import "../styles/side-panel.css";
import "../styles/animate.css";
import "../styles/table.css";
import "../styles/chart-window.css";

export default function EditorPage() {
  return <App />;
}
