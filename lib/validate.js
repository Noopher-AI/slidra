// Checks a .slidra deck against the specification and reports every problem
// with the rule it breaks: what readers must refuse (errors that stop the
// deck opening), what makes a slide corrupt, what writers must never
// produce, and the SHOULDs (warnings). Node-only; the CLI is
// bin/slidra-validate.mjs.

import { slideAccessibility, isElementContainer, SVG_NS } from "./viewer/a11y.js";
import { evaluateDeck } from "./conformance.js";
import { nodeDom } from "./node-dom.js";
import { checkAttributes, checkProject } from "./schema.js";
import { FORMAT_VERSION, NAMESPACE } from "./viewer/deck.js";
import { slideIdOf } from "./viewer/links.js";
import { deckPathFor } from "./viewer/slide.js";
import { SqliteReader, isSqlite } from "./viewer/sqlite-reader.js";

/**
 * @typedef {"error" | "warning"} Severity
 * @typedef {{ severity: Severity, code: string, message: string, rule: string, path?: string, element?: string }} Issue
 * @typedef {{ file: string, valid: boolean, errors: Issue[], warnings: Issue[], summary: { container: string | null, formatVersion: number | null, slides: number } }} Report
 */

const URL_ATTRIBUTES = ["href", "src", "poster", "data-slidra-media"];
const XLINK_NS = "http://www.w3.org/1999/xlink";

function elementsUnder(root) {
  const out = [];
  const walk = (node) => {
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.nodeType !== 1) continue;
      out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

const attributesOf = (el) => Object.fromEntries(Array.from(el.attributes, (a) => [a.name, a.value]).filter(([name]) => !name.startsWith("xmlns")));

/**
 * @param {Uint8Array} bytes the deck file
 * @param {{ fileName?: string }} [options]
 * @returns {Promise<Report>}
 */
export async function validateDeck(bytes, { fileName = "deck.slidra" } = {}) {
  /** @type {Issue[]} */
  const issues = [];
  const add = (severity, code, message, rule, where = {}) => issues.push({ severity, code, message, rule, ...where });

  // Container header: what the reader tolerates but writers must not produce.
  if (isSqlite(bytes)) {
    try {
      const db = new SqliteReader(bytes);
      if (db.writeVersion === 2 || db.readVersion === 2) add("error", "container-wal", "The deck is in WAL mode; writers must leave it in journal_mode DELETE.", "format §1.1");
      if (db.applicationId === 0) add("warning", "container-application-id", "PRAGMA application_id is 0; writers set it to 0x536C6472 (Sldr).", "format §1.1");
      if (db.userVersion === 0) add("warning", "container-user-version", "PRAGMA user_version is 0; writers set it to the formatVersion.", "format §1.1");
    } catch {
      /* the reader reports it below */
    }
  }

  const verdict = await evaluateDeck(bytes, fileName);
  if (verdict.open === "reject") {
    add("error", "deck-rejected", verdict.reason, "format §1–§2");
    return report(fileName, issues, { container: null, formatVersion: null, slides: 0 });
  }
  const deck = verdict.deck;
  if (deck.legacy) {
    const form = deck.container === "zip" ? "ZIP container" : "SQLite container";
    add(
      "warning",
      "legacy-format-version",
      `A legacy deck (formatVersion ${deck.project.formatVersion}, ${form}); readers may open it read-only, but writers produce formatVersion ${FORMAT_VERSION}.`,
      "format §1.2",
    );
  }

  // project.json against the schema (writer rules included).
  for (const problem of checkProject(deck.project))
    add("error", "project-schema", `project.json${problem.path === "/" ? "" : problem.path}: ${problem.message}`, "format §2", { path: "project.json" });
  if (typeof deck.project.cover === "string" && !deck.slides.includes(deck.project.cover))
    add("error", "project-cover", `cover ${deck.project.cover} is not one of the slides.`, "format §2", { path: "project.json" });
  if (typeof deck.project.lang !== "string") add("warning", "a11y-lang", "project.json has no lang; screen readers cannot tell the deck's language.", "format §4.7", { path: "project.json" });

  // Required directories and fonts.
  for (const dir of ["slides", "assets", "fonts"]) {
    if (deck.entries.get(dir) !== null) add("error", "container-directory", `The deck has no ${dir}/ directory row.`, "format §1.3");
  }
  const fonts = Array.isArray(deck.project.fonts) ? deck.project.fonts : [];
  const registered = new Set();
  for (const font of fonts) {
    if (!font || typeof font.file !== "string") continue;
    registered.add(font.file);
    if (typeof font.licenseFile === "string") registered.add(font.licenseFile);
    if (!deck.hasFile(font.file)) add("error", "font-missing", `Registered font ${font.file} is not in the deck.`, "format §8", { path: "project.json" });
    if (typeof font.licenseFile === "string" && !deck.hasFile(font.licenseFile))
      add("error", "font-license-missing", `Font licence ${font.licenseFile} is not in the deck.`, "format §8", { path: "project.json" });
  }
  const families = fonts.map((font) => font && font.family).filter(Boolean);
  for (const family of new Set(families.filter((f, i) => families.indexOf(f) !== i)))
    add("error", "font-family-duplicate", `Font family "${family}" is registered twice.`, "format §2.2", { path: "project.json" });
  for (const entry of deck.list()) {
    if (entry.startsWith("fonts/") && deck.hasFile(entry) && !registered.has(entry) && fonts.length > 0)
      add("warning", "font-unregistered", `${entry} is in fonts/ but not registered in project.json.`, "format §8", { path: entry });
  }

  // Slides.
  const slideIds = new Map();
  deck.slides.forEach((slidePath, index) => {
    const result = verdict.slides[index];
    if (result.status === "corrupt") add("error", "slide-corrupt", (result.error ?? "The slide is corrupt.").replace(`${slidePath}: `, ""), "format §6.4, §7", { path: slidePath });

    const source = deck.readText(slidePath);
    const doc = new nodeDom.DOMParser().parseFromString(source, "image/svg+xml");
    const root = doc.documentElement;
    if (!root || root.localName !== "svg" || doc.getElementsByTagName("parsererror").length > 0) return;

    const slideId = slideIdOf(source);
    if (root.hasAttribute("data-slidra-slide-id") && !slideId)
      add("error", "slide-id-shape", `data-slidra-slide-id "${root.getAttribute("data-slidra-slide-id")}" is not s- followed by 12 base64url characters.`, "format §3", { path: slidePath });
    if (slideId) {
      if (slideIds.has(slideId)) add("error", "slide-id-duplicate", `Slide id ${slideId} is also used by ${slideIds.get(slideId)}.`, "format §3", { path: slidePath });
      else slideIds.set(slideId, slidePath);
    }

    const viewBox = (root.getAttribute("viewBox") ?? "")
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    if (viewBox.length !== 4 || viewBox[2] !== deck.canvas.width || viewBox[3] !== deck.canvas.height) {
      add("error", "slide-viewbox", `viewBox "${root.getAttribute("viewBox") ?? ""}" does not match the canvas ${deck.canvas.width}×${deck.canvas.height}.`, "format §3", { path: slidePath });
    }

    checkVocabulary(root, slidePath, add);
    checkElements(root, slidePath, add);
    checkReferences(deck, root, slidePath, add);

    for (const warning of result.warnings) add("warning", "link-ignored", warning, "format §4.8", { path: slidePath });

    const a11y = slideAccessibility(root, { lang: typeof deck.project.lang === "string" ? deck.project.lang : null });
    for (const id of a11y.unnamed)
      add("warning", "a11y-unnamed", `${id} shows an image, media or a chart but has neither a <title> nor data-slidra-decorative="true".`, "format §4.7", { path: slidePath, element: id });
  });

  return report(fileName, issues, { container: deck.container, formatVersion: deck.project.formatVersion, slides: deck.slides.length });
}

/** Every Slidra element and element container against metadata.schema.json. */
function checkVocabulary(root, slidePath, add) {
  const vocabulary = ["effect", "transition", "comment", "chart", "series", "categories", "source"];
  for (const name of vocabulary) {
    for (const el of Array.from(root.getElementsByTagNameNS(NAMESPACE, name))) {
      for (const problem of checkAttributes(name, attributesOf(el)))
        add("error", "vocabulary", `<slidra:${name}>${problem.path === "/" ? "" : problem.path}: ${problem.message}`, "format §5–§12", {
          path: slidePath,
          element: el.getAttribute("target") ?? el.getAttribute("id") ?? undefined,
        });
    }
  }
  for (const problem of checkAttributes("slide", attributesOf(root)))
    add("error", "vocabulary", `<svg>${problem.path === "/" ? "" : problem.path}: ${problem.message}`, "format §3", { path: slidePath });
  for (const el of elementsUnder(root)) {
    if (isElementContainer(el)) {
      for (const problem of checkAttributes("element", attributesOf(el)))
        add("error", "vocabulary", `${problem.path === "/" ? "element" : problem.path.slice(1)}: ${problem.message}`, "format §4", { path: slidePath, element: el.getAttribute("id") });
    }
    if (el.hasAttribute("data-slidra-cell")) {
      for (const problem of checkAttributes("cell", attributesOf(el)))
        add("error", "vocabulary", `table cell${problem.path === "/" ? "" : problem.path}: ${problem.message}`, "format §12", { path: slidePath });
    }
  }
}

/** Element-level rules: unique ids, the id shape, one background, content inside containers. */
function checkElements(root, slidePath, add) {
  const seen = new Set();
  for (const el of elementsUnder(root)) {
    const id = el.getAttribute("id");
    if (!id) continue;
    if (seen.has(id)) add("error", "element-id-duplicate", `The id ${id} is used more than once on this slide.`, "format §4.1", { path: slidePath, element: id });
    seen.add(id);
  }
  const backgrounds = elementsUnder(root).filter((el) => el.getAttribute("data-slidra-role") === "background");
  if (backgrounds.length > 1) add("error", "background-duplicate", 'More than one element has data-slidra-role="background".', "format §4.6", { path: slidePath });
  if (backgrounds.length === 1) {
    const children = Array.from(root.childNodes).filter((n) => n.nodeType === 1 && !(n.namespaceURI === SVG_NS && (n.localName === "metadata" || n.localName === "title" || n.localName === "desc")));
    if (children[0] !== backgrounds[0])
      add("error", "background-position", "The background element must be the first element after <metadata>.", "format §4.6", { path: slidePath, element: backgrounds[0].getAttribute("id") });
    if (backgrounds[0].getAttribute("data-slidra-lock") !== "true")
      add("error", "background-lock", 'The background element must carry data-slidra-lock="true".', "format §4.6", { path: slidePath, element: backgrounds[0].getAttribute("id") });
  }
  const loose = Array.from(root.childNodes).filter(
    (n) => n.nodeType === 1 && n.namespaceURI === SVG_NS && !["metadata", "title", "desc", "defs", "style"].includes(n.localName) && !isElementContainer(n),
  );
  for (const el of loose)
    add("warning", "element-loose", `A <${el.localName}> sits outside any element container, so it is not addressable.`, "format §4.1", {
      path: slidePath,
      element: el.getAttribute("id") ?? undefined,
    });
}

/** Deck-local references resolve to entries; absolute URLs make the deck depend on the network. */
function checkReferences(deck, root, slidePath, add) {
  for (const el of [root, ...elementsUnder(root)]) {
    const values = URL_ATTRIBUTES.map((name) => el.getAttribute(name)).filter((value) => value !== null && value !== "");
    const xlink = el.getAttributeNS(XLINK_NS, "href");
    if (xlink) values.push(xlink);
    for (const value of values) {
      if (el.hasAttribute("data-slidra-embed") && value === el.getAttribute("data-slidra-media")) continue;
      if (/^https?:/i.test(value)) {
        add("warning", "reference-external", `${value} is loaded from the network, so the deck is not self-contained.`, "format §13", { path: slidePath, element: el.getAttribute("id") ?? undefined });
        continue;
      }
      const entry = deckPathFor(value, slidePath);
      if (entry !== null && !deck.hasFile(entry))
        add("warning", "reference-missing", `${value} points at ${entry}, which is not in the deck.`, "format §13", { path: slidePath, element: el.getAttribute("id") ?? undefined });
    }
  }
}

function report(file, issues, summary) {
  const errors = issues.filter((issue) => issue.severity === "error");
  const warnings = issues.filter((issue) => issue.severity === "warning");
  return { file, valid: errors.length === 0, errors, warnings, summary };
}
