// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Icon, type IconName, type IconSize } from "../src/icons/index.js";

// Icon's public boundary is the markup it renders, not the registry's
// internal path data (NOOP-376 Plan §6) — every assertion below renders
// through react-dom/server and inspects the resulting string.

const ALL_ICON_NAMES: IconName[] = [
  "plus",
  "template",
  "paste",
  "cut",
  "copy",
  "textbox",
  "shape",
  "arrange",
  "image",
  "video",
  "audio",
  "number",
  "none",
  "fade",
  "fromstart",
  "fromhere",
  "fullscr",
  "prev",
  "next",
  "view-normal",
  "view-grid",
  "view-play",
  "edit",
  "forward",
  "backward",
];

describe("Icon", () => {
  it("all 25 IconNames render an svg with a viewBox and aria-hidden", () => {
    expect(ALL_ICON_NAMES).toHaveLength(25);
    for (const name of ALL_ICON_NAMES) {
      const markup = renderToStaticMarkup(createElement(Icon, { name }));
      expect(markup).toContain('viewBox="0 0 20 20"');
      expect(markup).toContain('aria-hidden="true"');
    }
  });

  it("the rendered output contains no hardcoded color values or px literals", () => {
    for (const name of ALL_ICON_NAMES) {
      const markup = renderToStaticMarkup(createElement(Icon, { name }));
      // currentColor legitimately contains none of these substrings, so a
      // plain search for the forbidden literals is enough.
      expect(markup).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(markup).not.toContain("rgb(");
      expect(markup).not.toContain("hsl(");
      expect(markup).not.toMatch(/\d+px/);
    }
  });

  it("each of the three sizes renders its corresponding --icon-* token", () => {
    const expectations: Record<IconSize, string> = {
      inline: "var(--icon-inline)",
      control: "var(--icon-control)",
      command: "var(--icon-command)",
    };
    for (const [size, token] of Object.entries(expectations) as [IconSize, string][]) {
      const markup = renderToStaticMarkup(createElement(Icon, { name: "plus", size }));
      expect(markup).toContain(token);
    }
  });

  it("defaults to command when size is not given", () => {
    const withDefault = renderToStaticMarkup(createElement(Icon, { name: "plus" }));
    const withExplicit = renderToStaticMarkup(createElement(Icon, { name: "plus", size: "command" }));
    expect(withDefault).toBe(withExplicit);
  });

  it("an unknown icon name throws", () => {
    expect(() => renderToStaticMarkup(createElement(Icon, { name: "not-a-real-icon" as IconName }))).toThrow(
      "Unknown icon name",
    );
  });
});
