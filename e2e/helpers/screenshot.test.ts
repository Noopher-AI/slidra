// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import type { Page } from "playwright";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compareScreenshot } from "./screenshot.js";

/**
 * Regression guard for the CI/local appearance-baseline split:
 * `SKIP_APPEARANCE_BASELINES=1` must skip the pixel compare entirely, and
 * its absence must leave the normal compare path untouched. No baseline
 * PNGs exist for `name`, so the un-skipped call is expected to reach
 * `page.screenshot()` and then fail on the missing-baseline error — that
 * failure is the proof it took the compare path, not the skip path.
 *
 * `UPDATE_APPEARANCE_BASELINES` outranks the skip flag in `compareScreenshot`
 * (deliberately — see screenshot.ts), so this describe must clear it before
 * each test and restore it after: a CI `update_baselines` run has it set to
 * `1`, which would otherwise short-circuit both SKIP assertions here into
 * the write path instead of the paths this suite exists to check.
 */
describe("compareScreenshot / SKIP_APPEARANCE_BASELINES", () => {
  let savedUpdateFlag: string | undefined;

  beforeEach(() => {
    savedUpdateFlag = process.env.UPDATE_APPEARANCE_BASELINES;
    delete process.env.UPDATE_APPEARANCE_BASELINES;
  });

  afterEach(() => {
    delete process.env.SKIP_APPEARANCE_BASELINES;
    if (savedUpdateFlag === undefined) delete process.env.UPDATE_APPEARANCE_BASELINES;
    else process.env.UPDATE_APPEARANCE_BASELINES = savedUpdateFlag;
  });

  function fakePage(): { page: Page; getScreenshotCalls: () => number } {
    let screenshotCalls = 0;
    const page = {
      screenshot: async () => {
        screenshotCalls++;
        return Buffer.from([]);
      },
    } as unknown as Page;
    return { page, getScreenshotCalls: () => screenshotCalls };
  }

  it("skips the pixel compare when the flag is set", async () => {
    process.env.SKIP_APPEARANCE_BASELINES = "1";
    const { page, getScreenshotCalls } = fakePage();

    await expect(
      compareScreenshot(page, { name: "no-such-baseline", baselineDir: "/tmp/does-not-exist" }),
    ).resolves.toBeUndefined();
    expect(getScreenshotCalls()).toBe(0);
  });

  it("still compares when the flag is absent", async () => {
    const { page, getScreenshotCalls } = fakePage();

    await expect(
      compareScreenshot(page, { name: "no-such-baseline", baselineDir: "/tmp/does-not-exist" }),
    ).rejects.toThrow(/Baseline screenshot not found/);
    expect(getScreenshotCalls()).toBe(1);
  });
});
