export { CoMotionError, CoMotionNotFoundError } from "./errors.js";
export { generateOpaqueId, generateElementId } from "./id.js";
export { FORMAT_VERSION, SLIDE_FILE_NAME, buildMinimalPresentation } from "./presentation.js";
export { DEFAULT_FONT_FAMILY } from "./default-font.js";
export { readDefaultFontBytes } from "./default-font-bytes.js";
export type { MinimalPresentationFiles } from "./presentation.js";
export { validateProjectJson, readTemplateEntries, assertSupportedFormatVersion } from "./project-json.js";
export type { ProjectJson, FontEntry, TemplateEntry } from "./project-json.js";
export {
  addSlide,
  deleteSlide,
  duplicateSlide,
  moveSlide,
  addTemplate,
  listTemplates,
  renameTemplate,
  deleteTemplate,
  setNotes,
  setTransition,
} from "./slide-ops.js";
export type { AddSlideInput, AddSlideResult, DuplicateSlideResult, AddTemplateInput, AddTemplateResult } from "./slide-ops.js";
export { MEDIA_FORMATS, detectMediaFormat } from "./media-format.js";
export type { MediaFormatEntry, MediaKind } from "./media-format.js";
export { resolveAssetImport, sanitizeAssetBaseName, resolveConflictFreeFilename } from "./asset-import.js";
export type { ResolveAssetImportInput, ResolvedAssetImport } from "./asset-import.js";
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
  insertSlideElement,
  deleteSlideElements,
  moveSlideElements,
  rotateSlideElements,
  scaleSlideElements,
  setSlideElementStyle,
  reorderSlideElements,
  renderSlideForDisplay,
  createPresentationFile,
  deletePresentationFile,
  lockSlideElements,
  unlockSlideElements,
  groupSlideElements,
  ungroupSlideElements,
  alignSlideElements,
  distributeSlideElements,
  setSlideElementName,
  copySlideElements,
  pasteSlideClipboard,
  duplicateSlideElements,
  cutSlideElements,
} from "./workspace.js";
export type { AddTextBoxInput } from "./workspace.js";
export {
  insertElement,
  deleteElements,
  moveElements,
  rotateElements,
  scaleElements,
  setElementStyle,
  reorderElements,
  lockElements,
  unlockElements,
  STYLE_ATTRIBUTE_WHITELIST,
} from "./element-edit.js";
export type { InsertElementKind, InsertElementInput, OrderDirection, MutationOptions } from "./element-edit.js";
export { groupElements, ungroupElements, setElementName } from "./element-group.js";
export { alignElements, distributeElements } from "./element-arrange.js";
export type { AlignDirection, DistributeAxis } from "./element-arrange.js";
export { extractElementsForCopy, pasteElements } from "./element-clipboard.js";
export type { ClipboardPayload, PasteResult } from "./element-clipboard.js";
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
