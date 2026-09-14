// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { describe, expect, it } from "vitest";
import { isNearBottom } from "../src/shell/side/ChatPanel.js";

// The chat log follows new messages only while the author is already
// reading the bottom: someone who scrolled up to re-read an earlier
// command must not be yanked back down by the next streamed chunk.
describe("chat autoscroll near-bottom detection", () => {
  const clientHeight = 600;

  it("counts as at-bottom when fully scrolled to the bottom", () => {
    expect(isNearBottom(2000, 1400, clientHeight)).toBe(true);
  });

  it("counts as at-bottom when a few pixels off (fractional pixels, a line growing mid-stream)", () => {
    expect(isNearBottom(2000, 1360, clientHeight)).toBe(true);
  });

  it("does not count as at-bottom after scrolling up to read older messages", () => {
    expect(isNearBottom(2000, 900, clientHeight)).toBe(false);
  });

  it("counts as at-bottom when content hasn't grown enough to need scrolling", () => {
    expect(isNearBottom(400, 0, clientHeight)).toBe(true);
  });
});
