// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { describe, expect, it } from "vitest";
import { installUnsavedGuard } from "../src/unsaved-guard.js";

/** Dispatches a real `beforeunload` event and reports whether it was cancelled — jsdom implements `preventDefault()`/`defaultPrevented` for it, same as a real browser. */
function dispatchBeforeUnload(): boolean {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

describe("unsaved-guard.ts: installUnsavedGuard", () => {
  it("calls preventDefault() on beforeunload while dirty, and not once uninstalled or not dirty", () => {
    let dirty = true;
    const uninstall = installUnsavedGuard(() => dirty);

    expect(dispatchBeforeUnload()).toBe(true);

    dirty = false;
    expect(dispatchBeforeUnload()).toBe(false);

    dirty = true;
    uninstall();
    expect(dispatchBeforeUnload()).toBe(false);
  });
});
