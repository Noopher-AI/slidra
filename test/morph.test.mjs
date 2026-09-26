import { test } from "node:test";
import assert from "node:assert/strict";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { planMorph } from "../lib/viewer/morph.js";

/** @returns {any} xmldom stands in for the browser's DOM; morph.js only uses DOM Level 2 calls. */
const parse = (body) => new DOMParser().parseFromString(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">${body}</svg>`, "image/svg+xml").documentElement;
const xml = { serialize: (node) => new XMLSerializer().serializeToString(node) };
const shot = (ids) => ({
  elements: Object.fromEntries(ids.map((id, i) => [id, { box: { x: i * 10, y: 0, width: 50, height: 20 }, matrix: [1, 0, 0, 1, i * 10, 5], opacity: 0.8 }])),
  background: "rgb(16, 20, 24)",
});

const outgoing = parse(`
  <g id="el-stay00000000"><rect width="10" height="10"/></g>
  <g id="el-gone00000000" transform="translate(40 50)" opacity="0.5"><defs><linearGradient id="grad"/></defs><rect fill="url(#grad)" width="10" height="10"/><use href="#grad"/></g>
  <g id="el-group0000000"><g id="el-inner00000000"><text>leaves with its group</text></g><g id="el-kept00000000"><text>kept</text></g></g>
  <g id="el-hidden000000"><text>pre-hidden on the next slide</text></g>
  <g id="el-offscreen000"><text>was not shown</text></g>
`);
const incoming = parse(`
  <g id="el-stay00000000"><rect width="20" height="20"/></g>
  <g id="el-kept00000000"><text>kept</text></g>
  <g id="el-hidden000000"><text>pre-hidden</text></g>
  <g id="el-new000000000"><text>new</text></g>
`);

test("pairs shown elements by id, leaving out pre-hidden ones", () => {
  const plan = planMorph(outgoing, shot(["el-stay00000000", "el-gone00000000", "el-group0000000", "el-inner00000000", "el-kept00000000", "el-hidden000000"]), incoming, ["el-hidden000000"], 0.8, xml);
  assert.deepEqual(Object.keys(plan.from), ["el-stay00000000", "el-kept00000000"]);
  assert.equal(plan.duration, 0.8);
  assert.equal(plan.background, "rgb(16, 20, 24)");
});

test("ghosts copy only the outermost departing elements, never a paired one, drawn where they were", () => {
  const plan = planMorph(outgoing, shot(["el-stay00000000", "el-gone00000000", "el-group0000000", "el-inner00000000", "el-kept00000000", "el-hidden000000"]), incoming, ["el-hidden000000"], 0.8, xml);
  const ghosts = parse(plan.ghosts);
  const wrappers = Array.from(ghosts.childNodes).filter((n) => n.nodeType === 1);
  assert.equal(wrappers.length, 3, "el-gone, el-group (el-inner rides inside it) and el-hidden");
  for (const w of wrappers) {
    assert.ok(w.hasAttribute("data-slidra-ghost"));
    assert.equal(w.getAttribute("aria-hidden"), "true");
    assert.match(w.getAttribute("transform"), /^matrix\(/);
  }
  assert.doesNotMatch(plan.ghosts, /id="el-/, "no ghost keeps an element id");
  assert.doesNotMatch(plan.ghosts, /kept/, "a paired element inside a departing group is not copied");
  assert.match(plan.ghosts, /leaves with its group/);
  assert.match(plan.ghosts, /id="slidra-ghost-grad"/);
  assert.match(plan.ghosts, /fill="url\(#slidra-ghost-grad\)"/);
  assert.match(plan.ghosts, /href="#slidra-ghost-grad"/);
  assert.doesNotMatch(plan.ghosts, /translate\(40 50\)/, "the element's own transform is folded into the wrapper matrix");
  assert.match(plan.ghosts, /opacity="0.8"/);
  assert.doesNotMatch(plan.ghosts, /was not shown/, "elements the outgoing slide did not show are not ghosted");
});

test("a morph between unrelated slides pairs nothing", () => {
  const plan = planMorph(parse('<g id="el-a00000000000"/>'), shot(["el-a00000000000"]), parse('<g id="el-b00000000000"/>'), [], 0.5, xml);
  assert.deepEqual(Object.keys(plan.from), []);
  assert.match(plan.ghosts, /slidra-ghost-el-a00000000000/);
});
