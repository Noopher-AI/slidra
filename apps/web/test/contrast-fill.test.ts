// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { describe, expect, it } from "vitest";
import { contrastFill } from "../src/contrast-fill.js";

// Reads the page background (treating none as white), filling dark
// (#1f1a1a) for high brightness and light (#f4f6f8) for low brightness.
// Direction is the only contract: a dark page always gets the light value,
// a light page always gets the dark value.
describe("contrastFill", () => {
  it("treats null (no page background) as white, returns the dark color", () => {
    expect(contrastFill(null)).toBe("#1f1a1a");
  });

  it("a white background (#ffffff) returns the dark color", () => {
    expect(contrastFill("#ffffff")).toBe("#1f1a1a");
  });

  it("the demo deck's dark page background (#101418) returns the light color", () => {
    expect(contrastFill("#101418")).toBe("#f4f6f8");
  });

  it("accepts 3-digit hex (#000) and returns the light color", () => {
    expect(contrastFill("#000")).toBe("#f4f6f8");
  });

  it("accepts an rgb() function form, behaving the same as the equivalent hex", () => {
    expect(contrastFill("rgb(16, 20, 24)")).toBe("#f4f6f8");
  });

  it("an unparseable value (not hex or rgb()) is treated as no background, i.e. white", () => {
    expect(contrastFill("not-a-color")).toBe("#1f1a1a");
  });
});
