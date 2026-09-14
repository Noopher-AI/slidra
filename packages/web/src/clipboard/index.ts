// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

export { classifyClipboardText, type ClipboardTextKind } from "./payload.js";
export {
  copyCommandFor,
  cutCommandFor,
  pasteCommandFor,
  type CellRange,
  type CellRangeProvider,
  type ClipboardCommand,
  type ClipboardTarget,
} from "./dispatch.js";
