/**
 * Table barrel (E2.T14). No `node:` imports anywhere in this package,
 * transitively — the front end's overlay/preview channel loads this
 * directly, same discipline as `chart/index.ts`.
 */
export * from "./model.js";
export * from "./csv.js";
export * from "./markdown.js";
export * from "./layout.js";
export * from "./render.js";
export * from "./edit.js";
