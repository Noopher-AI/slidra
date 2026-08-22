import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./style.css";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("找不到掛載節點：#root");
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
