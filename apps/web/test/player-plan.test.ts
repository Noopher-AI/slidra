// Copyright 2026 Noopher AI
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUDIO_EXTENSIONS,
  computePlayerPlan,
  hideSelectorsFor,
  renderHideStyle,
  renderPlanScript,
  stageEmbedsFor,
  stageMediaFor,
  VIDEO_EXTENSIONS,
} from "../src/player-plan.js";
import { invalidateSlideEffectPlans } from "../src/effects.js";
import type { Effect } from "../src/effects.js";
// Cross-package: the server's own MIME table must agree with this player's
// extension allow-list, or an extension the player accepts silently falls
// back to application/octet-stream on the wire (see the describe block
// below). Not aliased in vitest.config.ts, so imported by relative path —
// same convention this project already uses for other .ts-as-.js imports.
import { rawContentTypeFor } from "../../../packages/server/src/raw.js";

// Seam C's parent half (C3): markup in, plan out. `computePlayerPlan` no
// longer derives `steps`/`effects` from the markup itself: that
// computation now lives server-side (`effect list`'s `data`, plan 4.1),
// fetched here through `fetchSlideEffectPlan`'s `/api/effects/` route
// client. Every test below stubs that route with `mockEffectsRoute` rather
// than relying on the `<slidra:effect>` markup embedded in its fixture SVGs
// (kept in the fixtures for readability only — computePlayerPlan itself
// never reads it anymore). The rest of this module's derivation
// (hidden/media/stageMedia/embedIds) is still a pure, synchronous function
// of `svgMarkup` alone, unaffected by that change.

const NS = 'xmlns:slidra="https://slidra.app/ns/2026"';
const SLIDE_PATH = "slides/001.svg";

function slide(effectLines: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg">
  <metadata>
    <slidra:effects ${NS}>
      ${effectLines}
    </slidra:effects>
  </metadata>
  <rect id="el-a"/>
  <rect id="el-b"/>
  <rect id="el-bg"/>
</svg>`;
}

interface EffectFixture {
  target: string;
  family: Effect["family"];
  effect: Effect["effect"];
  start: Effect["start"];
  duration?: number;
  delay?: number;
  d?: string;
}

const DEFAULT_TRANSITION = { enter: { effect: "none", duration: 0.6 }, exit: { effect: "none", duration: 0.5 } };

/**
 * Groups an ordered, 1-based-indexed effect list into steps exactly like
 * `effect list`'s server-side step derivation — a small, stable
 * reimplementation kept ONLY for building this file's stub route
 * responses. `computePlayerPlan` itself no longer derives steps at all
 * (that is the whole point of this ticket); this helper exists so a test
 * only has to state its effect list once, not the list AND its grouping
 * separately.
 */
function groupIntoSteps<T extends { start: Effect["start"] }>(effects: T[]): Array<{ effects: T[] }> {
  const steps: Array<{ effects: T[] }> = [];
  for (const effect of effects) {
    if (effect.start === "on-click") {
      steps.push({ effects: [effect] });
    } else {
      steps[steps.length - 1]!.effects.push(effect);
    }
  }
  return steps;
}

let fetchSpy: ReturnType<typeof vi.spyOn> | undefined;

afterEach(() => {
  fetchSpy?.mockRestore();
  fetchSpy = undefined;
  invalidateSlideEffectPlans();
});

/** Stubs `GET /api/effects/*` (the only route `computePlayerPlan`'s tests ever hit) with a fixed, legal effect list, wire-shaped with 1-based `index` and grouped into steps the same way the real route does. */
function mockEffectsRoute(effects: EffectFixture[]): void {
  const wireEffects = effects.map((effect, i) => ({ duration: 0.6, delay: 0, ...effect, index: i + 1 }));
  const wireSteps = groupIntoSteps(wireEffects);
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
    async () =>
      new Response(JSON.stringify({ effects: wireEffects, steps: wireSteps, transition: DEFAULT_TRANSITION }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
}

/** Stubs `GET /api/effects/*` with a damaged-list (or otherwise non-2xx) response. */
function mockEffectsRouteError(message: string, status = 500): void {
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
    async () =>
      new Response(JSON.stringify({ error: message }), { status, headers: { "content-type": "application/json" } }),
  );
}

describe("computePlayerPlan", () => {
  it("derives steps, and lists every enter target in hidden", async () => {
    const svg = slide(
      [
        '<slidra:effect target="el-a" family="enter" effect="fade" start="on-click"/>',
        '<slidra:effect target="el-b" family="enter" effect="appear" start="on-click"/>',
      ].join("\n"),
    );
    mockEffectsRoute([
      { target: "el-a", family: "enter", effect: "fade", start: "on-click" },
      { target: "el-b", family: "enter", effect: "appear", start: "on-click" },
    ]);

    const plan = await computePlayerPlan(svg, SLIDE_PATH);

    expect(plan).toEqual({
      steps: [
        {
          effects: [
            { target: "el-a", family: "enter", effect: "fade", start: "on-click", duration: 0.6, delay: 0, index: 0 },
          ],
        },
        {
          effects: [
            { target: "el-b", family: "enter", effect: "appear", start: "on-click", duration: 0.6, delay: 0, index: 1 },
          ],
        },
      ],
      hidden: ["el-a", "el-b"],
      hideSelectors: { "el-a": "#el-a", "el-b": "#el-b" },
      media: {},
      stageMedia: {},
      embedIds: [],
      transition: DEFAULT_TRANSITION,
    });
  });

  it("lists a target in hidden only once even if it appears twice", async () => {
    // Not a realistic effect list, but the dedupe rule must hold regardless.
    const svg = slide(
      [
        '<slidra:effect target="el-a" family="enter" effect="fade" start="on-click"/>',
        '<slidra:effect target="el-a" family="enter" effect="appear" start="on-click"/>',
      ].join("\n"),
    );
    mockEffectsRoute([
      { target: "el-a", family: "enter", effect: "fade", start: "on-click" },
      { target: "el-a", family: "enter", effect: "appear", start: "on-click" },
    ]);

    expect((await computePlayerPlan(svg, SLIDE_PATH)).hidden).toEqual(["el-a"]);
  });

  // [E2.T7]/D12: hidden means "not on screen when the slide opens" — only
  // true when a target's FIRST effect entry in the file is `enter`. An
  // element that exits before it ever gets an entrance effect was already
  // visible; pre-hiding it would be wrong.
  it("does not list a target in hidden when its first effect entry is not enter, even if an enter follows later", async () => {
    const svg = slide(
      [
        '<slidra:effect target="el-a" family="exit" effect="fade-out" start="on-click"/>',
        '<slidra:effect target="el-a" family="enter" effect="fade" start="on-click"/>',
      ].join("\n"),
    );
    mockEffectsRoute([
      { target: "el-a", family: "exit", effect: "fade-out", start: "on-click" },
      { target: "el-a", family: "enter", effect: "fade", start: "on-click" },
    ]);
    expect((await computePlayerPlan(svg, SLIDE_PATH)).hidden).toEqual([]);
  });

  it("stageEmbedsFor captures third-party embeds, while stageMedia explicitly skips them", async () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg">' +
      '<g id="el-embed" data-slidra-media="https://www.youtube-nocookie.com/embed/MtKyexX-GQc" data-slidra-type="video" data-slidra-embed="youtube"/>' +
      '<g id="el-file" data-slidra-media="../assets/clip.webm" data-slidra-type="video"/>' +
      "</svg>";
    mockEffectsRoute([]);

    expect(stageEmbedsFor(svg)).toEqual({
      "el-embed": { provider: "youtube", url: "https://www.youtube-nocookie.com/embed/MtKyexX-GQc" },
    });
    expect(Object.keys(stageMediaFor(svg))).toEqual(["el-file"]);
    expect((await computePlayerPlan(svg, SLIDE_PATH)).embedIds).toEqual(["el-embed"]);
  });

  it("when a media effect targets an embed: it is not added to the media cues, does not throw for lacking an extension, and still counts as one step", async () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg">' +
      '<metadata><slidra:effects xmlns:slidra="https://slidra.app/ns/2026">' +
      '<slidra:effect target="el-embed" family="media" effect="play" start="on-click"/>' +
      "</slidra:effects></metadata>" +
      '<g id="el-embed" data-slidra-media="https://www.youtube-nocookie.com/embed/MtKyexX-GQc" data-slidra-type="video" data-slidra-embed="youtube"/>' +
      "</svg>";
    mockEffectsRoute([{ target: "el-embed", family: "media", effect: "play", start: "on-click" }]);

    const plan = await computePlayerPlan(svg, SLIDE_PATH);
    expect(plan.media).toEqual({});
    expect(plan.embedIds).toEqual(["el-embed"]);
    expect(plan.steps).toHaveLength(1);
  });

  it("an unrecognized embed source is skipped rather than throwing", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg">' +
      '<g id="el-x" data-slidra-media="https://vimeo.com/1" data-slidra-embed="vimeo"/>' +
      "</svg>";
    expect(stageEmbedsFor(svg)).toEqual({});
  });

  it("stageMedia captures every data-slidra-media element, including ones no effect targets", async () => {
    mockEffectsRoute([]);
    const plan = await computePlayerPlan(
      '<svg xmlns="http://www.w3.org/2000/svg">' +
        '<g id="el-no-effect" data-slidra-media="../assets/clip.webm" data-slidra-type="video"/>' +
        "</svg>",
      SLIDE_PATH,
    );

    expect(plan.media).toEqual({});
    expect(plan.stageMedia).toEqual({ "el-no-effect": { src: "../assets/clip.webm", kind: "video" } });
  });

  it("a slide with no effect list gets zero steps and an empty hidden list", async () => {
    mockEffectsRoute([]);
    expect(
      await computePlayerPlan('<svg xmlns="http://www.w3.org/2000/svg"><rect id="el-bg"/></svg>', SLIDE_PATH),
    ).toEqual({
      steps: [],
      hidden: [],
      hideSelectors: {},
      media: {},
      stageMedia: {},
      embedIds: [],
      transition: DEFAULT_TRANSITION,
    });
  });

  it("rethrows the route's error message verbatim when parsing fails", async () => {
    // "build" is [E2.T7]'s stand-in fixture value for "a family this round
    // still does not implement" (exit is now real, D4) — same role the old
    // fixture's "exit" used to play.
    const svg = slide('<slidra:effect target="el-a" family="build" effect="fade" start="on-click"/>');
    mockEffectsRouteError("item 1 (target is el-a)'s family value \"build\" not yet implemented.");
    await expect(computePlayerPlan(svg, SLIDE_PATH)).rejects.toThrow(/family.*build/);
  });
});

describe("computePlayerPlan: cache", () => {
  it("calling with the same slidePath twice only invokes the fake fetch once", async () => {
    const svg = slide("");
    mockEffectsRoute([]);

    await computePlayerPlan(svg, SLIDE_PATH);
    await computePlayerPlan(svg, SLIDE_PATH);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("calling again after invalidateSlideEffectPlans() invokes the fake fetch a second time", async () => {
    const svg = slide("");
    mockEffectsRoute([]);

    await computePlayerPlan(svg, SLIDE_PATH);
    invalidateSlideEffectPlans();
    await computePlayerPlan(svg, SLIDE_PATH);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe("renderHideStyle", () => {
  it("returns an empty string when there are no hidden targets", () => {
    expect(renderHideStyle([])).toBe("");
  });

  // [E2.T7]/D7: one rule per id (not one rule for a joined selector list)
  // — the runtime removes a single id's rule by rewriting this exact
  // stylesheet's textContent from `plan.hideSelectors`, so the two must
  // agree on what "one id's rule" looks like. The `id="slidra-hide"` on the
  // `<style>` itself is what the runtime looks the element up by.
  it("renders each hidden target as its own CSS rule, setting opacity to 0 with !important", () => {
    // !important is load-bearing (gate review round 2, P2): a slide
    // element can carry its own inline opacity, which normally beats an
    // injected stylesheet rule regardless of that rule's specificity —
    // without !important here, such an element would flash fully visible
    // at the very start of play, exactly the bug this rule exists to stop.
    expect(renderHideStyle(["el-a", "el-b"])).toBe(
      '<style id="slidra-hide">#el-a{opacity:0 !important}#el-b{opacity:0 !important}</style>',
    );
  });

  it("escapes an id starting with a digit into a legal CSS identifier", () => {
    // A naive "escape every non-alphanumeric character" regex leaves a
    // leading digit untouched, producing the syntactically invalid
    // selector `#1-title` — the browser drops the whole rule, and that
    // element starts visible (gate review round 2, P2). CSS identifiers
    // cannot start with an unescaped digit; it must be hex-escaped.
    expect(renderHideStyle(["1-title"])).toBe('<style id="slidra-hide">#\\31 -title{opacity:0 !important}</style>');
  });

  it("escapes an id that is a single hyphen into \\-", () => {
    expect(renderHideStyle(["-"])).toBe('<style id="slidra-hide">#\\-{opacity:0 !important}</style>');
  });
});

// [E2.T7]/D7: `plan.hideSelectors` is the same escaped-selector table
// `renderHideStyle` derives its rules from — computed once, here, so the
// runtime never re-implements `cssEscapeId`.
describe("hideSelectorsFor", () => {
  it("maps each id to its own escaped CSS id selector", () => {
    expect(hideSelectorsFor(["el-a", "1-title"])).toEqual({ "el-a": "#el-a", "1-title": "#\\31 -title" });
  });

  it("returns an empty object for an empty list", () => {
    expect(hideSelectorsFor([])).toEqual({});
  });
});

describe("computePlayerPlan: media", () => {
  function slideWithMedia(mediaAttr: string): string {
    return `<svg xmlns="http://www.w3.org/2000/svg">
  <metadata>
    <slidra:effects ${NS}>
      <slidra:effect target="el-video" family="media" effect="play" start="on-click"/>
    </slidra:effects>
  </metadata>
  <image id="el-video"${mediaAttr}/>
</svg>`;
  }

  const mediaEffectFixture: EffectFixture = { target: "el-video", family: "media", effect: "play", start: "on-click" };

  it("a .mp4 video extension yields kind: video, with src as the raw data-slidra-media value", async () => {
    const svg = slideWithMedia(' data-slidra-media="assets/intro.mp4"');
    mockEffectsRoute([mediaEffectFixture]);
    expect((await computePlayerPlan(svg, SLIDE_PATH)).media).toEqual({
      "el-video": { src: "assets/intro.mp4", kind: "video" },
    });
  });

  it("an .oga audio extension yields kind: audio", async () => {
    const svg = slideWithMedia(' data-slidra-media="assets/narration.oga"');
    mockEffectsRoute([mediaEffectFixture]);
    expect((await computePlayerPlan(svg, SLIDE_PATH)).media).toEqual({
      "el-video": { src: "assets/narration.oga", kind: "audio" },
    });
  });

  it("throws when a media effect's target has no data-slidra-media, naming the target in the message", async () => {
    const svg = slideWithMedia("");
    mockEffectsRoute([mediaEffectFixture]);
    await expect(computePlayerPlan(svg, SLIDE_PATH)).rejects.toThrow(/el-video/);
  });

  it(".ogg is not in the allow-list; throws and points to .oga or .ogv instead", async () => {
    const svg = slideWithMedia(' data-slidra-media="assets/clip.ogg"');
    mockEffectsRoute([mediaEffectFixture]);
    await expect(computePlayerPlan(svg, SLIDE_PATH)).rejects.toThrow(/\.oga/);
    mockEffectsRoute([mediaEffectFixture]);
    await expect(computePlayerPlan(svg, SLIDE_PATH)).rejects.toThrow(/\.ogv/);
  });

  it("a slide with no media effects gets an empty media object", async () => {
    const svg = slide("");
    mockEffectsRoute([]);
    expect((await computePlayerPlan(svg, SLIDE_PATH)).media).toEqual({});
  });

  // SVG element ids are author-controlled, untrusted strings (ADR-0010) —
  // nothing stops a legal id from being "__proto__". A plain `{}` built up
  // via `media[target] = cue` does not create an own property for that key:
  // assigning to "__proto__" on an object whose prototype chain still has
  // Object.prototype's __proto__ accessor instead reassigns the object's own
  // [[Prototype]], so the cue silently never becomes a real, enumerable, own
  // "media" entry — even though later code might still happen to read the
  // right value back via that same accessor (a coincidence this test does
  // not rely on). hasOwnProperty is the direct, unambiguous check for "was
  // this actually stored as data".
  // Test inventory: merged with the former "constructor" id test (same
  // layer, same behaviour, only the string differed) — both ids now
  // asserted here so neither input is lost. The layer that actually catches
  // a real regression for "constructor" is player-runtime.test.ts:473,
  // which is kept as-is.
  it.each(["__proto__", "constructor"])(
    'produces the correct media cue when the target id is exactly "%s" (not swallowed into an empty object by prototype pollution)',
    async (id) => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg">
  <metadata>
    <slidra:effects ${NS}>
      <slidra:effect target="${id}" family="media" effect="play" start="on-click"/>
    </slidra:effects>
  </metadata>
  <rect id="${id}" data-slidra-media="assets/clip.mp4"/>
</svg>`;
      mockEffectsRoute([{ target: id, family: "media", effect: "play", start: "on-click" }]);

      const plan = await computePlayerPlan(svg, SLIDE_PATH);

      expect(Object.prototype.hasOwnProperty.call(plan.media, id)).toBe(true);
      expect(plan.media[id]).toEqual({ src: "assets/clip.mp4", kind: "video" });
    },
  );
});

describe("player allow-list must stay in sync with the server's MIME table", () => {
  // Both extensions this module hard-codes into VIDEO_EXTENSIONS/
  // AUDIO_EXTENSIONS must resolve to a real Content-Type on the server side
  // — an extension the player is willing to play but the server serves as
  // application/octet-stream is exactly the failure mode this guards against
  // (some browsers refuse to decode media without a real Content-Type,
  // some sniff bytes and decode anyway — "green on one machine, red on
  // another"). This test reads both allow-lists live, not a copy of either,
  // so it actually catches the next person adding an extension to one side
  // and forgetting the other.
  it.each([...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS])(
    "an extension %s the player allows resolves to a non-application/octet-stream Content-Type on the server",
    (extension) => {
      expect(rawContentTypeFor(`assets/clip${extension}`)).not.toBe("application/octet-stream");
    },
  );
});

describe("renderPlanScript", () => {
  it("serializes the plan into a one-line script assigned to window.__SLIDRA_PLAN__, reconstructed via JSON.parse rather than an object literal", () => {
    // Not a bare object-literal assignment: see the "full injection-chain
    // reconstruction" block below for why. This expected string is a
    // known-good literal (double
    // JSON.stringify of the same plan, computed independently of
    // renderPlanScript's own implementation), not a value recomputed the
    // way the code computes it.
    const plan = { steps: [], hidden: ["el-a"] };
    expect(renderPlanScript(plan)).toBe(
      "window.__SLIDRA_PLAN__ = JSON.parse(\"{\\\"steps\\\":[],\\\"hidden\\\":[\\\"el-a\\\"],\\\"startStep\\\":-1}\");",
    );
  });

  // startStep defaults to -1 ("this slide has not been advanced yet") when
  // the caller passes nothing — today's behaviour, unchanged for every
  // existing call site.
  it("startStep defaults to -1 when the second argument is omitted", () => {
    const plan = { steps: [], hidden: [] };
    expect(renderPlanScript(plan)).toContain('\\"startStep\\":-1');
  });

  // A caller wanting play to start mid-slide (retreat landing on the last
  // step) passes an explicit startStep.
  it("carries the given value through when startStep is passed", () => {
    const plan = { steps: [], hidden: [] };
    expect(renderPlanScript(plan, 2)).toContain('\\"startStep\\":2');
  });
});

// computePlayerPlan()'s own return value already round-trips "__proto__"
// as a real own property (see the "computePlayerPlan: media" tests above,
// fixed by Object.create(null) in mediaCuesFor) — but that is only the
// parent side of the wire.
// renderPlanScript()'s output is injected into the play iframe as raw
// script text and evaluated there; if that text reconstructs the plan via
// a bare object-literal assignment, ECMAScript's own object-literal syntax
// gives a non-computed `"__proto__": value` key special treatment — it
// sets [[Prototype]] instead of creating an own property — regardless of
// how carefully the value was built on this side. These tests exercise
// the *whole* chain: computePlayerPlan() -> renderPlanScript() -> a real
// JS engine evaluating that exact text against a window stand-in (not a
// mock of what evaluation "should" do) -> reading the reconstructed plan
// back.
describe("renderPlanScript: full injection-chain reconstruction (not just computePlayerPlan's return value)", () => {
  function evalInjectedScript(script: string): { steps: unknown; hidden: unknown; media: Record<string, unknown> } {
    const fakeWindow: { __SLIDRA_PLAN__?: unknown } = {};
    // eslint-disable-next-line no-new-func -- deliberately evaluating the
    // exact production script text with a real JS engine, the same thing
    // the play iframe does.
    new Function("window", script)(fakeWindow);
    return fakeWindow.__SLIDRA_PLAN__ as { steps: unknown; hidden: unknown; media: Record<string, unknown> };
  }

  it('plan.media remains a real own property after injection-chain reconstruction when the target id is exactly "__proto__"', async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg">
  <metadata>
    <slidra:effects ${NS}>
      <slidra:effect target="__proto__" family="media" effect="play" start="on-click"/>
    </slidra:effects>
  </metadata>
  <rect id="__proto__" data-slidra-media="assets/clip.mp4"/>
</svg>`;
    mockEffectsRoute([{ target: "__proto__", family: "media", effect: "play", start: "on-click" }]);
    const plan = await computePlayerPlan(svg, SLIDE_PATH);
    const script = renderPlanScript(plan);

    const reconstructed = evalInjectedScript(script);

    expect(Object.prototype.hasOwnProperty.call(reconstructed.media, "__proto__")).toBe(true);
    expect(reconstructed.media["__proto__"]).toEqual({ src: "assets/clip.mp4", kind: "video" });
    // hidden/steps are never keyed by untrusted ids (hidden is a plain
    // string[], steps is an array of {effects: Effect[]} with fixed
    // property names) — confirmed unaffected, not just assumed.
    expect(reconstructed.hidden).toEqual(plan.hidden);
    expect(reconstructed.steps).toEqual(plan.steps);
  });
});

describe("stageMediaFor (the stage media layer's kind determination stays in the parent)", () => {
  it("uses data-slidra-type as kind when present, ignoring the file extension", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg">
  <g id="el-1" data-slidra-type="audio" data-slidra-media="assets/clip.mp4"></g>
</svg>`;
    expect(stageMediaFor(svg)).toEqual({ "el-1": { src: "assets/clip.mp4", kind: "audio" } });
  });

  it("falls back to the file extension when data-slidra-type is absent (the only reason the media-deck/demo 004 fixtures still work)", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg">
  <rect id="el-1" data-slidra-media="../assets/clip.webm"/>
  <circle id="el-2" data-slidra-media="../assets/narration.oga"/>
</svg>`;
    expect(stageMediaFor(svg)).toEqual({
      "el-1": { src: "../assets/clip.webm", kind: "video" },
      "el-2": { src: "../assets/narration.oga", kind: "audio" },
    });
  });

  it("skips rather than throwing when data-slidra-media points to an image extension (the style-panel-deck PNG)", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg">
  <image id="el-1" data-slidra-media="../assets/photo.png"/>
</svg>`;
    expect(stageMediaFor(svg)).toEqual({});
  });

  it("skips rather than throwing for an unrecognized extension", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg">
  <g id="el-1" data-slidra-media="assets/mystery.xyz"></g>
</svg>`;
    expect(stageMediaFor(svg)).toEqual({});
  });

  it('produces the correct entry even when the id is "__proto__" (not swallowed into an empty object by prototype pollution)', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg">
  <rect id="__proto__" data-slidra-media="assets/clip.mp4"/>
</svg>`;
    const result = stageMediaFor(svg);
    expect(Object.prototype.hasOwnProperty.call(result, "__proto__")).toBe(true);
    expect(result["__proto__"]).toEqual({ src: "assets/clip.mp4", kind: "video" });
  });

  it("returns an empty table when there are no media elements", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><g id="el-1"><rect width="10" height="10"/></g></svg>`;
    expect(stageMediaFor(svg)).toEqual({});
  });
});
