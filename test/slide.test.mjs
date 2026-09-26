import { test } from "node:test";
import assert from "node:assert/strict";
import { nodeDom } from "../lib/node-dom.js";
import { openDeck } from "../lib/viewer/deck.js";
import { deckPathFor, prepareSlide, substituteDynamicText, useDom, youtubeVideoId } from "../lib/viewer/slide.js";
import { NS, makeDeck, svg } from "./fixtures/make-deck.mjs";

useDom(nodeDom);

const parse = (source) => new nodeDom.DOMParser().parseFromString(source, "image/svg+xml").documentElement;
const serialize = (node) => new nodeDom.XMLSerializer().serializeToString(node);

test("dynamic text: only leaf <text>/<tspan> character data, unknown names untouched (format §14)", () => {
  const root = parse(
    '<svg xmlns="http://www.w3.org/2000/svg"><text data-x="{{ slide_number }}">{{slide_number}} / {{ slide_total }} · {{ presentation_name }} · {{ unknown }}</text><text>Slide <tspan>{{ slide_number }}</tspan></text><g><desc>{{ slide_number }}</desc></g></svg>',
  );
  substituteDynamicText(root, { slide_number: "3", slide_total: "9", presentation_name: "Q3 <review>" });
  const markup = serialize(root);
  assert.match(markup, />3 \/ 9 · Q3 &lt;review(?:>|&gt;) · \{\{ unknown \}\}</);
  assert.match(markup, /data-x="\{\{ slide_number \}\}"/, "attributes are never substituted");
  assert.match(markup, /Slide <tspan>3<\/tspan>/);
  assert.match(markup, /<desc>\{\{ slide_number \}\}<\/desc>/, "only text and tspan");
  assert.match(markup, /<text>Slide <tspan>/, "a <text> with children is not a leaf; its own character data is left alone");
});

test("deck paths resolve against the slide and never leave the deck (format §13)", () => {
  assert.equal(deckPathFor("../assets/photo.png", "slides/001.svg"), "assets/photo.png");
  assert.equal(deckPathFor("../assets/my%20photo.png", "slides/001.svg"), "assets/my photo.png");
  assert.equal(deckPathFor("inline.svg", "slides/001.svg"), "slides/inline.svg");
  assert.equal(deckPathFor("../../../etc/passwd", "slides/001.svg"), "etc/passwd", "climbing is clamped at the deck root");
  for (const outside of ["https://example.com/x.png", "//cdn.example.com/x.png", "data:image/png;base64,AA", "#fragment", "/absolute.png", "", "  ", "javascript:alert(1)"])
    assert.equal(deckPathFor(outside, "slides/001.svg"), null, outside);
});

test("YouTube ids come only from YouTube hosts and well-formed ids", () => {
  assert.equal(youtubeVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(youtubeVideoId("https://youtu.be/dQw4w9WgXcQ?t=10"), "dQw4w9WgXcQ");
  assert.equal(youtubeVideoId("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(youtubeVideoId("https://m.youtube.com/shorts/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  for (const bad of [
    "https://evil.com/watch?v=dQw4w9WgXcQ",
    "https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ",
    "javascript:alert(1)",
    "https://www.youtube.com/watch?v=short",
    "not a url",
    "ftp://youtu.be/dQw4w9WgXcQ",
  ]) {
    assert.equal(youtubeVideoId(bad), null, bad);
  }
});

test("prepareSlide inlines every deck-local reference and leaves the rest alone", async () => {
  const deck = await openDeck(
    makeDeck({
      slides: [
        svg(
          [
            '<style>.bg{fill:url("../assets/pattern.svg")}</style>',
            '<g id="el-AAAAAAAAAAAA"><image href="../assets/photo.png"/><image xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="../assets/photo.png"/></g>',
            '<g id="el-BBBBBBBBBBBB" style="fill:url(../assets/pattern.svg)"><image href="../assets/missing.png"/><image href="https://example.com/remote.png"/></g>',
          ].join(""),
        ),
      ],
      files: { "assets/photo.png": new Uint8Array([137, 80, 78, 71]), "assets/pattern.svg": "<svg/>" },
    }),
  );
  const { markup } = prepareSlide(deck, 0);
  assert.equal((markup.match(/data:image\/png;base64,iVBORw==/g) ?? []).length, 2, "href and xlink:href");
  assert.match(markup, /\.bg\{fill:url\("data:image\/svg\+xml;base64,/);
  assert.match(markup, /style="fill:url\((?:&quot;|")data:image\/svg\+xml;base64,/);
  assert.match(markup, /href="\.\.\/assets\/missing\.png"/, "a missing entry is left as written");
  assert.match(markup, /href="https:\/\/example\.com\/remote\.png"/);
});

test("prepareSlide reads notes from every metadata block, media cues, embeds and the transition", async () => {
  const meta = `<slidra:notes xmlns:slidra="${NS}"> First. </slidra:notes><slidra:transition xmlns:slidra="${NS}" enter="slide" enter-duration="0.4"/>`;
  const effects = `<slidra:effects xmlns:slidra="${NS}"><slidra:effect target="el-VIDEOVIDEO01" family="media" effect="play" start="on-click"/><slidra:effect target="el-TUBETUBETUBE" family="media" effect="play" start="on-click"/></slidra:effects>`;
  const body = [
    '<g id="el-VIDEOVIDEO01" data-slidra-media="../assets/clip.webm"><rect width="10" height="10"/></g>',
    '<g id="el-AUDIOAUDIO01" data-slidra-media="../assets/voice.oga"><rect width="10" height="10"/></g>',
    '<g id="el-TYPEDTYPED01" data-slidra-media="../assets/clip.bin" data-slidra-type="video"><rect width="10" height="10"/></g>',
    '<g id="el-IMAGEIMAGE01" data-slidra-media="../assets/still.png"><rect width="10" height="10"/></g>',
    '<g id="el-TUBETUBETUBE" data-slidra-media="https://youtu.be/dQw4w9WgXcQ" data-slidra-embed="youtube"><rect width="10" height="10"/></g>',
    '<g id="el-OTHEREMBED01" data-slidra-media="https://vimeo.com/1" data-slidra-embed="vimeo"><rect width="10" height="10"/></g>',
    `<metadata><slidra:notes xmlns:slidra="${NS}">Second.</slidra:notes>${effects}</metadata>`,
  ].join("");
  const deck = await openDeck(makeDeck({ slides: [svg(body, { metadata: meta })], files: { "assets/clip.webm": "v", "assets/voice.oga": "a", "assets/clip.bin": "b" } }));
  const prepared = prepareSlide(deck, 0);
  assert.equal(prepared.notes, "First.\n\nSecond.");
  assert.deepEqual(prepared.transition.enter, { effect: "slide", duration: 0.4 });
  assert.deepEqual(Object.keys(prepared.plan.media), ["el-VIDEOVIDEO01"], "an embed is driven by the host, not as a media cue");
  assert.match(prepared.plan.media["el-VIDEOVIDEO01"].src, /^data:video\/webm;base64,/);
  assert.deepEqual(
    Object.entries(prepared.plan.stageMedia).map(([id, cue]) => [id, cue.kind]),
    [
      ["el-VIDEOVIDEO01", "video"],
      ["el-AUDIOAUDIO01", "audio"],
      ["el-TYPEDTYPED01", "video"],
    ],
  );
  assert.deepEqual(Object.keys(prepared.embeds), ["el-TUBETUBETUBE"], "only known providers");
  assert.deepEqual(prepared.plan.embedIds, ["el-TUBETUBETUBE"]);
});

test("a slide that is not well-formed becomes an error slide with the canvas size", async () => {
  const deck = await openDeck(makeDeck({ canvas: { width: 800, height: 600 }, slides: ['<svg xmlns="http://www.w3.org/2000/svg"><g></svg>'] }));
  const prepared = prepareSlide(deck, 0);
  assert.equal(prepared.plan, null);
  assert.match(prepared.error, /not well-formed SVG/);
  assert.match(prepared.markup, /viewBox="0 0 800 600"/);
  assert.match(prepared.markup, /slides\/001\.svg is not well-formed SVG/);
});
