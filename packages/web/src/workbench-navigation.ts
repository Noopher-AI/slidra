// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

/** A fresh page load receives a fresh bootstrap. Only the opaque, non-secret workbench id travels in the URL. */
export function workbenchPageUrl(currentPageUrl: string, workbenchId: string): string {
  const next = new URL("/", currentPageUrl);
  next.searchParams.set("workbench", workbenchId);
  return next.toString();
}
