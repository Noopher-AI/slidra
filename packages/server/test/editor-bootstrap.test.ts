// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { describe, expect, it } from "vitest";
import { EDITOR_BOOTSTRAP_MARKER, injectEditorBootstrap } from "../src/editor-bootstrap.js";

describe("injectEditorBootstrap", () => {
  it("injects separate deck and runner destinations without putting secrets in a URL", () => {
    const page = injectEditorBootstrap(
      new TextEncoder().encode(
        `<html><head><script id="slidra-bootstrap" type="application/json">__SLIDRA_BOOTSTRAP__</script></head><body></body></html>`,
      ),
      {
        workbenchId: "wb-1",
        deck: { url: "http://deck.internal:4900", credential: "deck-secret" },
        agentRunner: { url: "http://runner.internal:4901", sessionToken: "runner-secret" },
      },
    );
    const html = new TextDecoder().decode(page);

    expect(html).toContain('<script id="slidra-bootstrap" type="application/json">{');
    expect(html).toContain('"credential":"deck-secret"');
    expect(html).toContain('"sessionToken":"runner-secret"');
    expect(html).not.toContain("?deck-secret");
    expect(html).not.toContain("?runner-secret");
  });

  it("escapes HTML-breaking JSON characters and requires exactly one marker", () => {
    const html = new TextDecoder().decode(
      injectEditorBootstrap(new TextEncoder().encode(EDITOR_BOOTSTRAP_MARKER), {
        workbenchId: "</script><script>alert(1)</script>",
        deck: { url: "http://deck", credential: "a&b" },
        agentRunner: { url: "http://runner", sessionToken: "line\u2028separator" },
      }),
    );
    expect(html).not.toContain("</script><script>alert(1)</script>");
    expect(html).toContain("\\u003c/script\\u003e");
    expect(html).toContain("\\u0026");
    expect(html).toContain("\\u2028");

    const bootstrap = {
      workbenchId: "wb",
      deck: { url: "http://deck", credential: "deck" },
      agentRunner: { url: "http://runner", sessionToken: "runner" },
    };
    expect(() => injectEditorBootstrap(new TextEncoder().encode("<html></html>"), bootstrap)).toThrow("exactly one");
    expect(() => injectEditorBootstrap(new TextEncoder().encode(EDITOR_BOOTSTRAP_MARKER + EDITOR_BOOTSTRAP_MARKER), bootstrap)).toThrow(
      "exactly one",
    );
  });
});
