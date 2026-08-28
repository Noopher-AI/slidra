export { CoMotionError, CoMotionNotFoundError } from "./errors.js";
export { generateOpaqueId, generateElementId } from "./id.js";
export { FORMAT_VERSION, SLIDE_FILE_NAME, buildMinimalPresentation } from "./presentation.js";
export type { MinimalPresentationFiles } from "./presentation.js";
export { validateProjectJson } from "./project-json.js";
export type { ProjectJson, FontEntry } from "./project-json.js";
export {
  resolveCoMotionHome,
  resolveWorkDir,
  createNewPresentation,
  openPresentation,
  packPresentation,
  readPresentationFile,
  readPresentationFileBytes,
  listPresentationEntries,
  setElementText,
  writePresentationFile,
  addTextBox,
  setTextBoxWidth,
} from "./workspace.js";
export type { AddTextBoxInput } from "./workspace.js";
export { packDirectory } from "./container.js";
export { watchPresentation } from "./watch.js";
export type { PresentationWatcher } from "./watch.js";
export { measurePresentationText, resolvePresentationFonts } from "./fonts.js";
export type { MeasurePresentationTextOptions } from "./fonts.js";
export { parseFont, measureTextWidth } from "./text-metrics.js";
export type { FontMetrics } from "./text-metrics.js";
export * from "./geometry/index.js";
export * from "./slide/index.js";
export * from "./text/index.js";
export {
  recordSnapshot,
  beginHistoryGroup,
  endHistoryGroup,
  undoLastGroup,
  redoLastGroup,
} from "./history.js";
export type { HistoryEntry, HistoryGroup } from "./history.js";
