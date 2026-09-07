/**
 * Chart barrel (E2.T12). No `node:` imports anywhere in this package,
 * transitively — the front end loads this directly (`@co-motion/core/chart`
 * alias, see `packages/web/vite.config.ts`) for local preview.
 */
export * from "./model.js";
export * from "./csv.js";
export * from "./render.js";
export * from "./edit.js";
