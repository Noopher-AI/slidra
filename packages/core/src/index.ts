export { CoMotionError, CoMotionNotFoundError, CoMotionInvalidRequestError } from "./errors.js";
export { generateOpaqueId, generateElementId } from "./id.js";
export { FORMAT_VERSION, SLIDE_FILE_NAME, buildMinimalPresentation } from "./presentation.js";
export { DEFAULT_FONT_FAMILY } from "./default-font.js";
export { readDefaultFontBytes } from "./default-font-bytes.js";
// [E2.T3]: the pure string -> string splice `setNotes` (below) wraps for
// file I/O. Exported directly so `packages/web/test/notes.test.ts` can
// round-trip it against `readSlideNotes` without touching a real
// presentation on disk.
export { setSlideNotes } from "./notes.js";
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
  setSlideTransitionOn,
  addComment,
  editComment,
  deleteComment,
  listComments,
  listAllComments,
} from "./slide-ops.js";
export type {
  AddSlideInput,
  AddSlideResult,
  DuplicateSlideResult,
  AddTemplateInput,
  AddTemplateResult,
  SlideCommentWithPath,
  SetSlideTransitionOnInput,
} from "./slide-ops.js";
export type { PageStyle, PageStyleUpdate } from "./slide-style.js";
export { setSlideViewBox, setPresentationCanvas, assertValidCanvasDimension } from "./presentation-canvas.js";
export type { PresentationCanvasResult } from "./presentation-canvas.js";
export { MEDIA_FORMATS, detectMediaFormat } from "./media-format.js";
export type { MediaFormatEntry, MediaKind } from "./media-format.js";
export {
  resolveAssetImport,
  sanitizeAssetBaseName,
  resolveConflictFreeFilename,
  resolveDataAssetImport,
} from "./asset-import.js";
export type { ResolveDataAssetImportInput, ResolvedDataAssetImport } from "./asset-import.js";
export type { ResolveAssetImportInput, ResolvedAssetImport } from "./asset-import.js";
export {
  resolveCoMotionHome,
  resolveWorkDir,
  createNewPresentation,
  openPresentation,
  packPresentation,
  savePresentation,
  reopenPresentationInPlace,
  readSaveState,
  readPresentationFile,
  readPresentationFileBytes,
  listPresentationEntries,
  setElementText,
  writePresentationFile,
  writePresentationFileWithoutHistory,
  addTextBox,
  setTextBoxWidth,
  setTextBoxAlign,
  setSlidePageStyle,
  setSlideTextRunStyle,
  setSlideParagraphList,
  insertSlideElement,
  deleteSlideElements,
  moveSlideElements,
  rotateSlideElements,
  scaleSlideElements,
  resizeSlideElements,
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
  copyTableCells,
  cutTableCells,
  pasteTableCells,
  addSlideEffects,
  removeSlideEffects,
  moveSlideEffect,
  setSlideEffect,
  listSlideEffects,
  createSlideTable,
  setSlideTableCellText,
  setSlideTableCellStyle,
  mergeSlideTableCells,
  setSlideTableColWidth,
  insertSlideTableColumn,
  deleteSlideTableColumn,
  insertSlideTableRow,
  deleteSlideTableRow,
  setSlideTableTheme,
  setSlideTableHeader,
  bindSlideTableSource,
  refreshSlideTableSource,
  setSlideTable,
  createSlideChart,
  setSlideChartData,
  setSlideChartType,
  setSlideChartPalette,
  setSlideChartAxis,
  setSlideChartStack,
  setSlideChartLegend,
  setSlideChartOption,
} from "./workspace.js";
export type {
  AddTextBoxInput,
  SaveState,
  SetSlideTableCellStyleInput,
  MergeSlideTableCellsInput,
  SetSlideTableInput,
  SetSlideChartDataInput,
} from "./workspace.js";
export * from "./table/index.js";
export type { TextRunStyleUpdate, ListKind } from "./element-text.js";
export {
  insertElement,
  deleteElements,
  moveElements,
  rotateElements,
  scaleElements,
  resizeElements,
  setElementStyle,
  reorderElements,
  lockElements,
  unlockElements,
  STYLE_ATTRIBUTE_WHITELIST,
} from "./element-edit.js";
export type { InsertElementKind, InsertElementInput, OrderDirection, MutationOptions, ResizeAnchor } from "./element-edit.js";
export { youtubeVideoId, youtubeEmbedUrl, embedUrlFor, requireEmbedProvider, EMBED_PROVIDERS } from "./embed.js";
export type { EmbedProvider } from "./embed.js";
export { groupElements, ungroupElements, setElementName } from "./element-group.js";
export { alignElements, distributeElements } from "./element-arrange.js";
export type { AlignDirection, DistributeAxis } from "./element-arrange.js";
export { extractElementsForCopy, pasteElements, serializeClipboardSvg, parseClipboardSvg, sanitizeClipboardMarkup } from "./element-clipboard.js";
export type { ClipboardPayload, PasteResult } from "./element-clipboard.js";
export { copyTableCellRange, cutTableCellRange, pasteTableCellRange, parseCellRange, parseCellAnchor } from "./table-clipboard.js";
export type { CellRange, CellAnchor } from "./table-clipboard.js";
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
export * from "./effects/index.js";
export {
  readEffectList,
  addEffects,
  removeEffects,
  moveEffect,
  setEffect,
  removeEffectsTargeting,
} from "./effects/edit.js";
export type { AddEffectInput, SetEffectInput } from "./effects/edit.js";
export * from "./chart/index.js";
export {
  recordSnapshot,
  beginHistoryGroup,
  endHistoryGroup,
  undoLastGroup,
  redoLastGroup,
} from "./history.js";
export type { HistoryEntry, HistoryGroup } from "./history.js";
