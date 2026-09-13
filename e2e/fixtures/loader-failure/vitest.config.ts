// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { defineConfig } from "vitest/config";

// Used only by loader-failure-guard.test.ts's subprocess run. The main
// e2e/vitest.config.ts include (`e2e/**/*.test.ts`) never matches
// `*.fixture.ts`, so pointing vitest at that config makes it report
// "No test files found" instead of actually trying to load the fixture.
// This config's include exists solely to make the fixture collectible so
// its real load failure (not "no files found") is what fails the run.
export default defineConfig({
  test: {
    include: ["e2e/fixtures/loader-failure/*.fixture.ts"],
  },
});
