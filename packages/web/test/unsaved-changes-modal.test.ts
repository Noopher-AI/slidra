// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { UnsavedChangesModal, type UnsavedChangesModalProps } from "../src/shell/UnsavedChangesModal.js";

// Same convention as titlebar.test.ts: the component's public boundary is
// props → the rendered string. NOOP-422 AC5 is specifically about what the
// markup itself commits to — which button is the default and where the
// destructive one sits — so the string is exactly the right surface.
function markup(overrides: Partial<UnsavedChangesModalProps> = {}): string {
  const props: UnsavedChangesModalProps = {
    fileName: "deck.slidra",
    onSaveNow: () => {},
    onKeepEditing: () => {},
    onDiscard: () => {},
    ...overrides,
  };
  return renderToStaticMarkup(createElement(UnsavedChangesModal, props));
}

describe("UnsavedChangesModal", () => {
  it("names the deck file in the explanation, and appends the failure reason when there is one", () => {
    expect(markup()).toContain("deck.slidra");
    expect(markup({ reason: "deck.slidra is on a read-only volume." })).toContain("read-only volume");
  });

  it("makes Save now the only autofocused action (AC5: discarding is never the default)", () => {
    const rendered = markup();
    const saveButton = /<button[^>]*unsaved-changes-modal-save[^>]*>/.exec(rendered)?.[0] ?? "";
    const discardButton = /<button[^>]*unsaved-changes-modal-discard[^>]*>/.exec(rendered)?.[0] ?? "";
    expect(saveButton).toContain("autofocus");
    expect(discardButton).not.toContain("autofocus");
  });

  it("puts Discard changes last, after Save now and Keep editing", () => {
    const rendered = markup();
    expect(rendered.indexOf("Save now")).toBeGreaterThan(-1);
    expect(rendered.indexOf("Keep editing")).toBeGreaterThan(rendered.indexOf("Save now"));
    expect(rendered.indexOf("Discard changes")).toBeGreaterThan(rendered.indexOf("Keep editing"));
  });
});
