// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { describe, expect, it } from "vitest";
import { buildApplyMasterMessage } from "../src/shell/master-mode/master-prompt.js";

describe("buildApplyMasterMessage", () => {
  it("includes the template path and name when a name is present", () => {
    const message = buildApplyMasterMessage({ templatePath: "templates/002.svg", templateName: "Content", slideCount: 7 });
    expect(message).toContain("templates/002.svg");
    expect(message).toContain("Content");
  });

  it("includes the path with no empty parentheses when the name is null", () => {
    const message = buildApplyMasterMessage({ templatePath: "templates/002.svg", templateName: null, slideCount: 7 });
    expect(message).toContain("templates/002.svg");
    expect(message).not.toMatch(/\(\s*\)/);
    expect(message).not.toMatch(/""/);
  });

  it("starts with the skill invocation and states the slide count", () => {
    const message = buildApplyMasterMessage({ templatePath: "templates/002.svg", templateName: "Content", slideCount: 7 });
    expect(message.startsWith("/slidra-apply-master ")).toBe(true);
    expect(message).toContain("7");
  });
});
