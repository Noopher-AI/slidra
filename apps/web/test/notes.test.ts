import { describe, expect, it } from "vitest";
import { readSlideNotes } from "../src/notes.js";

const BLANK_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720"></svg>';

describe("readSlideNotes", () => {
  it("no <metadata>: empty string", () => {
    const result = readSlideNotes(BLANK_SVG);
    expect(result).toEqual({ ok: true, text: "" });
  });

  it("has <metadata> but no <slidra:notes>: empty string", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">' +
      '<metadata><slidra:effects xmlns:slidra="https://slidra.app/ns/2026"/></metadata>' +
      "</svg>";
    expect(readSlideNotes(svg)).toEqual({ ok: true, text: "" });
  });

  it("has <slidra:notes>: reads out the content", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">' +
      '<metadata><slidra:notes xmlns:slidra="https://slidra.app/ns/2026">Speaker notes v1</slidra:notes></metadata>' +
      "</svg>";
    expect(readSlideNotes(svg)).toEqual({ ok: true, text: "Speaker notes v1" });
  });

  it("notes with escaped characters: restores the original characters", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">' +
      '<metadata><slidra:notes xmlns:slidra="https://slidra.app/ns/2026">1 &lt; 2 &amp;&amp; true</slidra:notes></metadata>' +
      "</svg>";
    expect(readSlideNotes(svg)).toEqual({ ok: true, text: "1 < 2 && true" });
  });

  it("notes with a newline: preserved as-is", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">' +
      '<metadata><slidra:notes xmlns:slidra="https://slidra.app/ns/2026">Line one\nLine two</slidra:notes></metadata>' +
      "</svg>";
    expect(readSlideNotes(svg)).toEqual({ ok: true, text: "Line one\nLine two" });
  });

  it("a legacy file (no xmlns): DOMParser considers it malformed, but readSlideNotes can still read it back", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">' +
      "<metadata><slidra:notes>Legacy speaker notes, no bound namespace</slidra:notes></metadata>" +
      "</svg>";
    expect(readSlideNotes(svg)).toEqual({ ok: true, text: "Legacy speaker notes, no bound namespace" });
  });

  it("markup with no readable <svg> root: reports an explicit error, not an empty string", () => {
    const result = readSlideNotes("<html><body>not a slide</body></html>");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("<svg>");
    }
  });

  it("markup syntax error (scanDocument throws): reports an explicit error", () => {
    const result = readSlideNotes('<svg xmlns="http://www.w3.org/2000/svg"><g></svg>');
    expect(result.ok).toBe(false);
  });

  // This used to be a round-trip test that wrote via core's setSlideNotes
  // and read the value back on the spot — with the expected value produced
  // by core itself, which is about to be removed from web. Changed to the
  // same kind of literal markup fixture as the tests above, covering the
  // same set of inputs (empty string / whitespace-only / & in the middle);
  // the "plain text", "escaped characters", and "newline" cases are already
  // covered verbatim by the existing tests above, so they aren't repeated
  // here.
  it("notes is an empty string: reads back an empty string", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">' +
      '<metadata><slidra:notes xmlns:slidra="https://slidra.app/ns/2026"></slidra:notes></metadata>' +
      "</svg>";
    expect(readSlideNotes(svg)).toEqual({ ok: true, text: "" });
  });

  it("notes is whitespace-only: preserved as-is", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">' +
      '<metadata><slidra:notes xmlns:slidra="https://slidra.app/ns/2026">   </slidra:notes></metadata>' +
      "</svg>";
    expect(readSlideNotes(svg)).toEqual({ ok: true, text: "   " });
  });

  it("notes with & in the middle: restores the original character", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">' +
      '<metadata><slidra:notes xmlns:slidra="https://slidra.app/ns/2026">A &amp; B &lt; C &gt; D</slidra:notes></metadata>' +
      "</svg>";
    expect(readSlideNotes(svg)).toEqual({ ok: true, text: "A & B < C > D" });
  });
});
