import { measureText } from "./text-metrics.js";

// A second vite entry (packages/web/vite.config.ts) whose only job is
// exposing browser-side text measurement on `window`, so e2e/text-
// metrics.test.ts can call it from Playwright's page context, and so a
// future text-box-wrapping feature can call the exact same function from
// application code without going through this entry at all.
declare global {
  interface Window {
    coMotionMeasureText: typeof measureText;
  }
}

window.coMotionMeasureText = measureText;
