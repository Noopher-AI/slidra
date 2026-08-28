// Barrel for the text module (#76). Same fan-out convention as font/,
// geometry/ and slide/: concurrent units extend this barrel instead of the
// shared packages/core/src/index.ts.
//
// No Node built-in import, not even transitively — see wrap.ts's and
// render.ts's own header comments for why.
export { wrapText, breakAllowedBetween, NO_BREAK_BEFORE, NO_BREAK_AFTER } from "./wrap.js";
export type { WrapOptions, WrappedLine, WrappedText } from "./wrap.js";
export { renderTextBoxContent } from "./render.js";
