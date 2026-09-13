// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { completeDraft, filterCommands, moveSelection, slashQuery, type SlashCommandOption } from "../src/slash-commands.js";
import { SlashMenu } from "../src/shell/side/SlashMenu.js";

/**
 * [E3.T3] #232/#236: unit tests for the `/` menu's pure logic and its
 * presentational component — same posture style-panel.test.ts already uses
 * for a presentational side-panel component (`renderToStaticMarkup`,
 * public-boundary only). Keyboard *interaction* (which key does what while
 * wired to a real `<input>`) is an e2e concern (no testing-library in this
 * package, see Plan §3.g) — this file only covers what each pure function
 * returns and what a given `commands`/`selectedIndex` renders as.
 */

describe("slashQuery", () => {
  it("a bare '/' triggers with an empty query", () => {
    expect(slashQuery("/")).toBe("");
  });

  it("'/out' triggers with query 'out'", () => {
    expect(slashQuery("/out")).toBe("out");
  });

  it("a space after the slash breaks the trigger (command + argument already typed)", () => {
    expect(slashQuery("/a b")).toBeNull();
  });

  it("a slash not in the first position does not trigger", () => {
    expect(slashQuery("abc/def")).toBeNull();
  });

  it("an empty draft does not trigger", () => {
    expect(slashQuery("")).toBeNull();
  });
});

describe("filterCommands", () => {
  const commands: SlashCommandOption[] = [
    { name: "outline", description: "Create slides from an outline" },
    { name: "outreach", description: "" },
    { name: "review", description: "Review the slides" },
  ];

  it("prefix match, case-insensitive, never fuzzy", () => {
    expect(filterCommands(commands, "out").map((c) => c.name)).toEqual(["outline", "outreach"]);
    expect(filterCommands(commands, "OUT").map((c) => c.name)).toEqual(["outline", "outreach"]);
    expect(filterCommands(commands, "tline")).toEqual([]); // fuzzy/substring match is explicitly out of scope
  });

  it("empty query matches everything", () => {
    expect(filterCommands(commands, "")).toHaveLength(3);
  });
});

describe("moveSelection", () => {
  it("wraps forward past the last item back to the first", () => {
    expect(moveSelection(2, 3, 1)).toBe(0);
  });

  it("wraps backward past the first item to the last", () => {
    expect(moveSelection(0, 3, -1)).toBe(2);
  });

  it("an empty list always yields 0", () => {
    expect(moveSelection(0, 0, 1)).toBe(0);
    expect(moveSelection(5, 0, -1)).toBe(0);
  });
});

describe("completeDraft", () => {
  it("prefixes '/' and appends a trailing space, so the trigger regex stops matching", () => {
    expect(completeDraft("outline")).toBe("/outline ");
    expect(slashQuery(completeDraft("outline"))).toBeNull();
  });
});

describe("SlashMenu", () => {
  it("lists every command's name and description", () => {
    const markup = renderToStaticMarkup(
      createElement(SlashMenu, {
        commands: [
          { name: "outline", description: "Create slides from an outline" },
          { name: "review", description: "Review the slides" },
        ],
        selectedIndex: 0,
        onSelect: () => {},
      }),
    );
    expect(markup).toContain("/outline");
    expect(markup).toContain("Create slides from an outline");
    expect(markup).toContain("/review");
    expect(markup).toContain("Review the slides");
  });

  it("an empty command list shows the fixed hint text (AC4)", () => {
    const markup = renderToStaticMarkup(createElement(SlashMenu, { commands: [], selectedIndex: 0, onSelect: () => {} }));
    expect(markup).toContain("This agent has not reported any slash commands");
  });

  it("marks the selected item's aria-selected, not any other", () => {
    const markup = renderToStaticMarkup(
      createElement(SlashMenu, {
        commands: [
          { name: "a", description: "" },
          { name: "b", description: "" },
        ],
        selectedIndex: 1,
        onSelect: () => {},
      }),
    );
    expect(markup).toMatch(/aria-selected="false"[^>]*>[\s\S]*?\/a/);
    expect(markup).toMatch(/aria-selected="true"[^>]*>[\s\S]*?\/b/);
  });
});
