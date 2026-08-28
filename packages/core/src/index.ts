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
} from "./workspace.js";
export { packDirectory } from "./container.js";
export { watchPresentation } from "./watch.js";
export type { PresentationWatcher } from "./watch.js";
export { measurePresentationText } from "./fonts.js";
export type { MeasurePresentationTextOptions } from "./fonts.js";
