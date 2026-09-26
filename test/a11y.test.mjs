import { test } from "node:test";
import assert from "node:assert/strict";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { applyAccessibility, chartSummary, slideAccessibility, tableText, textOf } from "../lib/viewer/a11y.js";

const NS = "https://slidra.app/ns/2026";
/** xmldom elements stand in for DOM elements here; a11y.js only uses DOM Level 2 calls both provide. */
/** @returns {any} */
const parse = (body, rootAttrs = "") =>
  new DOMParser().parseFromString(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:slidra="${NS}" viewBox="0 0 1280 720"${rootAttrs}>${body}</svg>`, "image/svg+xml").documentElement;

const slide = parse(`
  <metadata><slidra:notes>notes are not content</slidra:notes></metadata>
  <title>Quarterly results</title>
  <g id="el-background" data-slidra-role="background" data-slidra-lock="true"><image href="../assets/bg.png" width="1280" height="720"/></g>
  <g id="el-glow00000000" data-slidra-decorative="true"><rect width="1280" height="720"/><text>decorative text is skipped</text></g>
  <g id="el-heading00000"><text x="96" y="120">Revenue grew</text></g>
  <g id="el-textbox00000" data-slidra-text-width="400"><text><tspan x="0" dy="0">Line one</tspan><tspan x="0" dy="28" data-slidra-break="true">Line two</tspan></text></g>
  <g id="el-photo0000000"><title>The team on a beach</title><desc>Twelve people, sunset</desc><image href="../assets/team.jpg"/></g>
  <g id="el-nameless0000"><image href="../assets/logo.png"/></g>
  <g id="el-group0000000"><g id="el-child10000000"><text>First in group</text></g><g id="el-child20000000"><text>Second in group</text></g></g>
  <g id="el-named-group0"><title>A named diagram</title><g id="el-inner00000000"><text>not read separately</text></g></g>
  <g id="el-chart0000000" data-slidra-type="chart"><slidra:chart type="bar" width="480" height="320"><slidra:series name="Revenue" values="100,120"/><slidra:series name="Costs" values="80,90"/><slidra:categories values="Q1,Q2"/></slidra:chart><svg width="480" height="320"/></g>
  <g id="el-table0000000" data-slidra-type="table"><g data-slidra-cell="1,0"><text><tspan>Taipei</tspan></text></g><g data-slidra-cell="0,1"><text><tspan>Units</tspan></text></g><g data-slidra-cell="0,0"><text><tspan>Region</tspan></text></g><g data-slidra-cell="1,1"><text><tspan>1,280</tspan></text></g><g data-slidra-cell="2,0" data-slidra-repeat="row" display="none"><text><tspan>{{row}}</tspan></text></g></g>
  <g id="el-video0000000" data-slidra-media="../assets/intro%20clip.webm"><rect/></g>
  <a href="#x"><g id="el-wrapped000000"><text>Inside a link</text></g></a>
`);

test("reads the slide title and the items in reading order", () => {
  const model = slideAccessibility(slide, { lang: "en" });
  assert.equal(model.title, "Quarterly results");
  assert.equal(model.lang, "en");
  assert.deepEqual(
    model.items.map((item) => [item.id, item.kind, item.text]),
    [
      ["el-heading00000", "text", "Revenue grew"],
      ["el-textbox00000", "text", "Line one\nLine two"],
      ["el-photo0000000", "image", "The team on a beach. Twelve people, sunset"],
      ["el-child10000000", "text", "First in group"],
      ["el-child20000000", "text", "Second in group"],
      ["el-named-group0", "group", "A named diagram"],
      ["el-chart0000000", "chart", "Bar chart. Revenue: Q1 100, Q2 120. Costs: Q1 80, Q2 90"],
      ["el-table0000000", "table", "Region, Units; Taipei, 1,280"],
      ["el-video0000000", "media", "Video: intro clip.webm"],
      ["el-wrapped000000", "text", "Inside a link"],
    ],
  );
});

test("flags images, media and charts that have neither a title nor a decorative marker", () => {
  assert.deepEqual(slideAccessibility(slide).unnamed, ["el-nameless0000", "el-chart0000000", "el-video0000000"]);
});

test("xml:lang on the slide overrides the deck language", () => {
  assert.equal(slideAccessibility(parse("", ' xml:lang="zh-Hant-TW"'), { lang: "en" }).lang, "zh-Hant-TW");
  assert.equal(slideAccessibility(parse(""), {}).lang, null);
});

test("helpers: text lines, chart summary, table text", () => {
  const root = parse('<g id="el-t"><text><tspan>one </tspan><tspan>word</tspan></text><text>second block</text></g>');
  assert.equal(textOf(root), "one word\nsecond block");
  assert.equal(
    chartSummary(parse('<g id="el-c"><slidra:chart type="donut"><slidra:series name="Bytes" values="1,2"/><slidra:categories values="A,B"/></slidra:chart></g>')),
    "Donut chart. Bytes: A 1, B 2",
  );
  assert.equal(tableText(parse("<g/>")), "");
});

test("applyAccessibility moves titles to aria-label and hides decoration", () => {
  const root = parse(
    '<title>Slide</title><g id="el-photo0000000"><title>Photo</title><desc>Long</desc><image/></g><g id="el-text00000000"><title>Heading</title><text>Hi</text></g><g id="el-dec000000000" data-slidra-decorative="true"><rect/></g>',
  );
  applyAccessibility(root, slideAccessibility(root, { lang: "en" }));
  const markup = new XMLSerializer().serializeToString(root);
  assert.doesNotMatch(markup, /<title>/, "no <title> is left to show as a tooltip");
  assert.match(markup, /id="el-photo0000000"[^>]*aria-label="Photo"/);
  assert.match(markup, /id="el-photo0000000"[^>]*role="img"/);
  assert.match(markup, /aria-description="Long"/);
  assert.doesNotMatch(markup, /id="el-text00000000"[^>]*role="img"/, "text keeps its own semantics");
  assert.match(markup, /id="el-dec000000000"[^>]*aria-hidden="true"/);
  assert.equal(root.getAttribute("aria-label"), "Slide");
  assert.equal(root.getAttribute("lang"), "en");
});
