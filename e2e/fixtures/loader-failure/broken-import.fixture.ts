// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

// Deliberately broken: used by loader-failure-guard.test.ts to prove that a
// file that fails to *load* still fails the run, not just a file whose
// assertions fail. Named `.fixture.ts`, not `.test.ts`, so the main
// `e2e/**/*.test.ts` run never collects it.
import x from "this-package-does-not-exist";
import { describe, it, expect } from "vitest";

describe("broken import fixture", () => {
  it("would pass if it ever ran", () => {
    expect(x).toBeUndefined();
  });
});
