export { CoMotionError } from "./errors.js";
export { generateOpaqueId, generateElementId } from "./id.js";
export { FORMAT_VERSION, SLIDE_FILE_NAME, buildMinimalPresentation } from "./presentation.js";
export type { ProjectJson, MinimalPresentationFiles } from "./presentation.js";
export {
  resolveCoMotionHome,
  createNewPresentation,
  openPresentation,
  packPresentation,
  readPresentationFile,
  listPresentationEntries,
  setElementText,
} from "./workspace.js";
export { watchPresentation } from "./watch.js";
export type { PresentationWatcher } from "./watch.js";
