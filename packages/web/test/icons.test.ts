import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Icon, type IconName, type IconSize } from "../src/icons/index.js";

// Icon's public boundary is the markup it renders, not the registry's
// internal path data (NOOP-3 Plan §6) — every assertion below renders
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
];

describe("Icon（NOOP-3 驗收）", () => {
  it("22 個 IconName 都能渲染出含 viewBox 與 aria-hidden 的 svg", () => {
    expect(ALL_ICON_NAMES).toHaveLength(22);
    for (const name of ALL_ICON_NAMES) {
      const markup = renderToStaticMarkup(createElement(Icon, { name }));
      expect(markup).toContain('viewBox="0 0 20 20"');
      expect(markup).toContain('aria-hidden="true"');
    }
  });

  it("渲染結果不含硬寫色值或 px 字面值", () => {
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

  it("三個 size 各自渲染出對應的 --icon-* token", () => {
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

  it("未給 size 時預設為 command", () => {
    const withDefault = renderToStaticMarkup(createElement(Icon, { name: "plus" }));
    const withExplicit = renderToStaticMarkup(createElement(Icon, { name: "plus", size: "command" }));
    expect(withDefault).toBe(withExplicit);
  });

  it("未知的圖示名稱會 throw", () => {
    expect(() => renderToStaticMarkup(createElement(Icon, { name: "not-a-real-icon" as IconName }))).toThrow(
      "未知的圖示名稱",
    );
  });
});
