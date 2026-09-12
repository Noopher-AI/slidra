import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
// Tokens first (ticket #49): style.css references --s-well/--ink/etc.,
// so the :root custom properties and the bundled @font-face must already
// exist by the time style.css's rules are parsed.
import "./styles/tokens.css";
import "./style.css";
import "./styles/shell.css";
import "./styles/stage.css";
import "./styles/stage-overlays.css";
import "./styles/dock.css";
import "./styles/rail.css";
import "./styles/plan-gate.css";
import "./styles/export-panel.css";
import "./styles/notes.css";
import "./styles/chat.css";
import "./styles/play.css";
import "./styles/selection.css";
import "./styles/side-panel.css";
import "./styles/animate.css";
import "./styles/table.css";
import "./styles/chart-window.css";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("找不到掛載節點：#root");
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
