// Barrel for the font module. Landed in wave 1's base commit so that
// concurrent units extend their own barrel instead of the shared
// packages/core/src/index.ts (fan-out structure).
export { createFontBook, MEASURED_TEXT_CSS } from "./metrics.js";
export type { FontBook, FontFaceInfo, TextStyle } from "./metrics.js";
export {
  BUNDLED_FONT_DIR,
  BUNDLED_FONT_FILE,
  BUNDLED_LICENCE_FILE,
  resolveFontCacheDir,
  readBundledFontBytes,
  ensureBundledFonts,
  stageBundledFonts,
  loadFontBook,
} from "./bundle.js";
// readPresentationFontBook lives in workspace.ts (it needs the id-to-workDir
// lookup), but it is re-exported from here rather than from the shared
// packages/core/src/index.ts, whose export list this wave must leave
// byte-identical.
export { readPresentationFontBook } from "../workspace.js";
