// Copyright 2026 Noopher AI
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { buildConfirmMessage, buildRedoMessage, extractJsonFence, parsePlanOutline } from "../src/plan-file.js";

const VALID_FENCE = JSON.stringify({
  status: "draft",
  mode: "pyramid",
  pages: [
    { n: 1, relationship: "none", type: "cover", rhythm: "anchor", title: "Cover" },
    // Most pages carry no `type` — the planner only names the relationship
    // and the build decides the layout.
    { n: 2, relationship: "membership", rhythm: "dense", title: "Three key points" },
  ],
  questions: [
    {
      id: "mode",
      question: "Narrative mode",
      note: "Conclusion-first saves the most time",
      recommended: "pyramid",
      options: [
        { value: "pyramid", label: "Conclusion first" },
        { value: "narrative", label: "Story arc" },
      ],
      free_text: true,
    },
  ],
});
const VALID_FILE = "```json\n" + VALID_FENCE + "\n```\n\n## Page 1\nClaim……\n";

describe("plan/outline.md's JSON fence", () => {
  it("extracts the leading fence and leaves the markdown body alone", () => {
    expect(extractJsonFence(VALID_FILE)).toBe(VALID_FENCE);
    expect(extractJsonFence("# No fence\n```json\n{}\n```")).toBeNull();
  });

  it("parses a well-formed outline", () => {
    const outline = parsePlanOutline(VALID_FILE);
    expect(outline).not.toBeNull();
    expect(outline!.status).toBe("draft");
    expect(outline!.mode).toBe("pyramid");
    expect(outline!.pages.map((p) => p.relationship)).toEqual(["none", "membership"]);
    expect(outline!.pages.map((p) => p.type)).toEqual(["cover", null]);
    expect(outline!.questions).toHaveLength(1);
    expect(outline!.questions[0]!.free_text).toBe(true);
    expect(outline!.fenceText).toBe(VALID_FENCE);
  });

  it("returns null (never throws) for a missing fence, malformed JSON, or a bad shape", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(parsePlanOutline("just prose")).toBeNull();
      expect(parsePlanOutline("```json\n{not json\n```")).toBeNull();
      expect(parsePlanOutline("```json\n" + JSON.stringify({ status: "later", mode: "x", pages: [] }) + "\n```")).toBeNull();
      // pages must be non-empty, numbered from 1, with known type/rhythm
      const badPages = { status: "draft", mode: "x", pages: [{ n: 2, relationship: "none", type: "cover", rhythm: "anchor", title: "" }] };
      expect(parsePlanOutline("```json\n" + JSON.stringify(badPages) + "\n```")).toBeNull();
      // recommended must be one of the options
      const badQuestion = {
        status: "draft",
        mode: "x",
        pages: [{ n: 1, relationship: "none", type: "cover", rhythm: "anchor", title: "t" }],
        questions: [{ id: "q", question: "?", recommended: "zzz", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] }],
      };
      expect(parsePlanOutline("```json\n" + JSON.stringify(badQuestion) + "\n```")).toBeNull();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("parses successfully even when the whole plan has no type (otherwise the confirmation dialog would never appear)", () => {
    // The regression this pins: `type` became optional in the plan contract
    // but this parser still required it, so every plan the planner wrote
    // was silently discarded and the gate modal never appeared.
    const noTypes = {
      status: "draft",
      mode: "briefing",
      pages: [
        { n: 1, relationship: "none", rhythm: "anchor", title: "Cover" },
        { n: 2, relationship: "order", rhythm: "dense", title: "Three steps" },
      ],
      questions: [
        { id: "palette", question: "Palette", recommended: "A", options: [{ value: "A", label: "Dark" }, { value: "B", label: "Light" }] },
      ],
    };
    const outline = parsePlanOutline("```json\n" + JSON.stringify(noTypes) + "\n```");
    expect(outline).not.toBeNull();
    expect(outline!.pages.map((p) => p.type)).toEqual([null, null]);
    expect(outline!.pages.map((p) => p.relationship)).toEqual(["none", "order"]);
    expect(outline!.questions).toHaveLength(1);
  });

  it("treats a missing or unlisted relationship as a malformed file", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const missing = { status: "draft", mode: "x", pages: [{ n: 1, rhythm: "anchor", title: "t" }] };
      expect(parsePlanOutline("```json\n" + JSON.stringify(missing) + "\n```")).toBeNull();
      const unknown = { status: "draft", mode: "x", pages: [{ n: 1, relationship: "sequence", rhythm: "anchor", title: "t" }] };
      expect(parsePlanOutline("```json\n" + JSON.stringify(unknown) + "\n```")).toBeNull();
      // A present-but-unknown `type` is still malformed.
      const badType = { status: "draft", mode: "x", pages: [{ n: 1, relationship: "none", type: "hero", rhythm: "anchor", title: "t" }] };
      expect(parsePlanOutline("```json\n" + JSON.stringify(badType) + "\n```")).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });

  it("a confirmed plan without questions parses with an empty list", () => {
    const confirmed = { status: "confirmed", mode: "briefing", pages: [{ n: 1, relationship: "none", type: "cover", rhythm: "anchor", title: "t" }] };
    const outline = parsePlanOutline("```json\n" + JSON.stringify(confirmed) + "\n```");
    expect(outline?.status).toBe("confirmed");
    expect(outline?.questions).toEqual([]);
  });
});

describe("gate messages (contract §4)", () => {
  it("builds the 【計畫確認】 message one answer per line, notes only when given", () => {
    const text = buildConfirmMessage({
      choices: { mode: "pyramid", "page-5": "number" },
      notes: { mode: "  ", "page-5": "Make the number bigger" },
      overall: "Trim the whole thing down",
    });
    expect(text).toBe("/slidra-build 【計畫確認】\nmode=pyramid\npage-5=number\npage-5.note=Make the number bigger\n補充：Trim the whole thing down");
  });

  it("builds the 【重做】 message", () => {
    expect(buildRedoMessage(" too many pages ")).toBe("/slidra-plan 【重做】too many pages");
  });
});
