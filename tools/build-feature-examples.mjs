// Builds the two feature tour decks under examples/ — a maintainer tool, not
// part of the viewer. Needs Node >= 22.5 (node:sqlite, via lib/writer/).
//
//   node --no-warnings tools/build-feature-examples.mjs --font Regular.otf --bold Bold.otf [--license LICENSE.txt] [--out dir]
//
// examples/motion.slidra   easing, fly directions, text builds, repeats, triggers, morph, links
// examples/sharing.slidra  metadata, agenda links, alt text, charts, language, presenter
//                          view, network consent, print / export / embed
//
// --font / --bold are Noto Sans TC subsets (OFL) covering every glyph the
// decks use; tools/.feature-text.txt lists them after a run without fonts.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DeckWriter } from "../lib/writer/index.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const argValue = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};
const OUT = argValue("--out") ? path.resolve(argValue("--out")) : path.join(ROOT, "examples");
const fontPath = argValue("--font");
const boldPath = argValue("--bold");
const licensePath = argValue("--license");

const NS = "https://slidra.app/ns/2026";
const SANS = "Noto Sans TC, PingFang TC, Microsoft JhengHei, system-ui, sans-serif";
const BOLD = `Noto Sans TC Bold, ${SANS}`;
const MONO = "ui-monospace, Menlo, Consolas, monospace";
const esc = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** `el-` + a 12-character id from a short name (letters and digits, padded). */
const id = (name) => `el-${name.padEnd(12, "0").slice(0, 12)}`;
/** `s-` + a 12-character slide id. */
const sid = (name) => `s-${name.padEnd(12, "0").slice(0, 12)}`;

const fx = (target, family, effect, start, extra = {}) =>
  `<slidra:effect target="${target}" family="${family}" effect="${effect}" start="${start}"${Object.entries(extra)
    .map(([k, v]) => ` ${k}="${esc(v)}"`)
    .join("")}/>`;

/** One slide: canvas 1280×720, its id, title, background, effects, transition, notes, language and body. */
function slide({ slideId, title, bg, effects = [], transition = null, notes = "", lang = null, body }) {
  const meta = [];
  if (effects.length) meta.push(`<slidra:effects xmlns:slidra="${NS}">\n      ${effects.join("\n      ")}\n    </slidra:effects>`);
  if (transition)
    meta.push(
      `<slidra:transition xmlns:slidra="${NS}"${Object.entries(transition)
        .map(([k, v]) => ` ${k}="${v}"`)
        .join("")}/>`,
    );
  if (notes) meta.push(`<slidra:notes xmlns:slidra="${NS}">${esc(notes)}</slidra:notes>`);
  const metadata = meta.length ? `  <metadata>\n    ${meta.join("\n    ")}\n  </metadata>\n` : "";
  const langAttr = lang ? ` xml:lang="${lang}"` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720" data-slidra-slide-id="${slideId}"${langAttr} style="background-color:${bg}" font-family="${SANS}">\n${metadata}  <title>${esc(title)}</title>\n${body.join("\n")}\n</svg>\n`;
}

/** An element container. `extra` holds raw attributes (links, decorative, …). */
const el = (key, name, inner, { transform = "", extra = "", label = null, desc = null } = {}) =>
  `  <g id="${id(key)}" data-slidra-name="${esc(name)}"${transform ? ` transform="${transform}"` : ""}${extra}>${label ? `<title>${esc(label)}</title>` : ""}${desc ? `<desc>${esc(desc)}</desc>` : ""}\n    ${inner}\n  </g>`;

const text = (x, y, size, fill, content, extra = "") => `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}"${extra}>${esc(content)}</text>`;
const bold = (x, y, size, fill, content, extra = "") => text(x, y, size, fill, content, ` font-family="${BOLD}"${extra}`);

// ─── Motion (dark) ─────────────────────────────────────────────────────

const D = {
  bg: "#101216",
  bg2: "#0f1a24",
  card: "#1b1f27",
  line: "#2a2f39",
  ink: "#f4f6f8",
  muted: "#a9b0b8",
  faint: "#6b7280",
  red: "#c8233b",
  blue: "#3b82f6",
  amber: "#e0a43a",
  green: "#3fb27f",
  violet: "#8b5cf6",
  cyan: "#22b8cf",
};

const darkFooter = () =>
  el("dfooter", "Footer", `${text(64, 684, 18, D.faint, "{{ presentation_name }}")}\n    ${text(1216, 684, 18, D.faint, "{{ slide_number }} / {{ slide_total }}", ' text-anchor="end"')}`);
const kicker = (key, x, y, label, fill = D.red) => el(key, "Kicker", text(x, y, 20, fill, label, ' font-weight="700" letter-spacing="4"'));

function motion() {
  const slides = [];

  // 1 · Title: a word build and an overshooting subtitle
  slides.push(
    slide({
      slideId: sid("motiontitle"),
      title: "Motion that means something",
      bg: D.bg,
      transition: { enter: "fade", "enter-duration": "0.8", exit: "fade", "exit-duration": "0.4" },
      notes:
        "A tour of what effects can say in a .slidra file. Click once: the title builds word by word, the subtitle drops in with an overshoot, the rule slides in from the left.\nEverything on these slides is declared in each slide's <metadata>; no script.",
      effects: [
        fx(id("ttitle"), "enter", "fade", "on-click", { duration: "0.5", by: "word", stagger: "0.14" }),
        fx(id("tsub"), "enter", "fly-down", "after-previous", { duration: "0.7", easing: "overshoot" }),
        fx(id("trule"), "enter", "fly-right", "with-previous", { duration: "0.6", easing: "ease-out" }),
      ],
      body: [
        el(
          "tglow",
          "Glow",
          `<defs><radialGradient id="tglowgrad" cx="0.8" cy="0.15" r="0.75"><stop offset="0" stop-color="${D.red}" stop-opacity="0.35"/><stop offset="1" stop-color="${D.red}" stop-opacity="0"/></radialGradient></defs><rect width="1280" height="720" fill="url(#tglowgrad)"/>`,
          { extra: ' data-slidra-decorative="true"' },
        ),
        kicker("tkick", 96, 230, "WHAT'S NEW · MOTION"),
        el("ttitle", "Title", bold(96, 340, 72, D.ink, "Motion that means something")),
        el("tsub", "Subtitle", text(100, 420, 34, D.muted, "Easing, text builds, triggers and morph, declared in the file.")),
        el("trule", "Rule", `<rect x="100" y="462" width="180" height="6" rx="3" fill="${D.red}"/>`),
        el("thint", "Hint", text(100, 560, 22, D.faint, "Press → or click to play · ? lists every key")),
        darkFooter(),
      ],
    }),
  );

  // 2 · Six easing curves on the same motion path
  const easings = [
    ["linear", D.muted],
    ["ease", D.blue],
    ["ease-in", D.cyan],
    ["ease-out", D.green],
    ["ease-in-out", D.amber],
    ["overshoot", D.red],
  ];
  slides.push(
    slide({
      slideId: sid("motioneasing"),
      title: "Six easing curves",
      bg: D.bg,
      transition: { enter: "slide", "enter-duration": "0.6", exit: "slide", "exit-duration": "0.4" },
      notes: "One click starts all six balls on the same path at the same moment; only the easing differs. Watch overshoot pass the finish line and settle back.",
      effects: easings.map(([name], i) => fx(id(`ball${i}`), "path", "path", i === 0 ? "on-click" : "with-previous", { d: "M0 0 L760 0", duration: "1.8", easing: name })),
      body: [
        kicker("ekick", 96, 92, "EASING"),
        el("ehead", "Heading", bold(96, 150, 50, D.ink, "Same path, six ways to get there")),
        ...easings.flatMap(([name, color], i) => {
          const y = 238 + i * 72;
          return [
            el(
              `lane${i}`,
              `Lane ${name}`,
              `${text(96, y + 8, 22, D.muted, name, ` font-family="${MONO}"`)}<line x1="330" y1="${y}" x2="1110" y2="${y}" stroke="${D.line}" stroke-width="2" stroke-dasharray="6 8"/><line x1="1110" y1="${y - 18}" x2="1110" y2="${y + 18}" stroke="${D.faint}" stroke-width="2"/>`,
            ),
            el(`ball${i}`, `Ball ${name}`, `<circle cx="0" cy="0" r="16" fill="${color}"/>`, { transform: `translate(350 ${y})` }),
          ];
        }),
        darkFooter(),
      ],
    }),
  );

  // 3 · Fly in from any side, leave the same way
  const cards = [
    ["up", "fly-up", "fly-out-up", "↑", D.blue, 360, 250],
    ["down", "fly-down", "fly-out-down", "↓", D.green, 700, 250],
    ["left", "fly-left", "fly-out-left", "←", D.amber, 360, 440],
    ["right", "fly-right", "fly-out-right", "→", D.violet, 700, 440],
  ];
  slides.push(
    slide({
      slideId: sid("motionflying"),
      title: "Fly in from any side",
      bg: D.bg,
      transition: { enter: "zoom", "enter-duration": "0.5" },
      notes: "Step 1: four cards fly in, each from its own side, one after another. Step 2: they all leave together the way their name says.",
      effects: [
        ...cards.map(([key, enter], i) => fx(id(`fly${key}`), "enter", enter, i === 0 ? "on-click" : "after-previous", { duration: "0.45", easing: "ease-out" })),
        ...cards.map(([key, , exit], i) => fx(id(`fly${key}`), "exit", exit, i === 0 ? "on-click" : "with-previous", { duration: "0.5", easing: "ease-in" })),
      ],
      body: [
        kicker("fkick", 96, 92, "DIRECTIONS"),
        el("fhead", "Heading", bold(96, 150, 50, D.ink, "Fly in from any side, leave the same way")),
        ...cards.map(([key, enter, exit, arrow, color, x, y]) =>
          el(
            `fly${key}`,
            `Card ${key}`,
            `<rect x="0" y="0" width="300" height="150" rx="18" fill="${color}"/>${text(28, 64, 54, "#ffffff", arrow)}${text(100, 64, 26, "#ffffff", enter, ` font-family="${MONO}"`)}${text(100, 106, 22, "#ffffff", exit, ` font-family="${MONO}" opacity="0.8"`)}`,
            { transform: `translate(${x} ${y})` },
          ),
        ),
        darkFooter(),
      ],
    }),
  );

  // 4 · Text builds by line, word and letter
  slides.push(
    slide({
      slideId: sid("motiontexts"),
      title: "Build text by line, word or letter",
      bg: D.bg,
      transition: { enter: "fade", "enter-duration": "0.5" },
      notes: "Three clicks, three builds. A text build fades each unit in turn; the glyphs never move, so the finished slide looks exactly like the static SVG.",
      effects: [
        fx(id("bline"), "enter", "fade", "on-click", { duration: "0.4", by: "line", stagger: "0.35" }),
        fx(id("bword"), "enter", "fade", "on-click", { duration: "0.3", by: "word", stagger: "0.12" }),
        fx(id("bletter"), "enter", "fade", "on-click", { duration: "0.2", by: "letter", stagger: "0.05" }),
      ],
      body: [
        kicker("bkick", 96, 92, "TEXT BUILDS"),
        el("bhead", "Heading", bold(96, 150, 50, D.ink, "Build text by line, word or letter")),
        el("blab1", "Label line", text(96, 240, 20, D.red, 'by="line"', ` font-family="${MONO}"`)),
        el(
          "bline",
          "Lines",
          `<text x="96" y="300" font-size="30" fill="${D.ink}"><tspan x="96" dy="0">One idea</tspan><tspan x="96" dy="46" data-slidra-break="true">per line,</tspan><tspan x="96" dy="46" data-slidra-break="true">one click.</tspan></text>`,
          { extra: ' data-slidra-text-width="320"' },
        ),
        el("blab2", "Label word", text(496, 240, 20, D.red, 'by="word"', ` font-family="${MONO}"`)),
        el(
          "bword",
          "Words",
          `<text x="496" y="300" font-size="30" fill="${D.ink}"><tspan x="496" dy="0">Every word</tspan><tspan x="496" dy="46" data-slidra-break="true">lands on its</tspan><tspan x="496" dy="46" data-slidra-break="true">own beat.</tspan></text>`,
          { extra: ' data-slidra-text-width="320"' },
        ),
        el("blab3", "Label letter", text(896, 240, 20, D.red, 'by="letter"', ` font-family="${MONO}"`)),
        el("bletter", "Letters", bold(896, 330, 72, D.ink, "Letters.")),
        el("bnote", "Note", text(96, 560, 22, D.faint, "The static SVG is the finished look: splitting text into units never moves a glyph.")),
        darkFooter(),
      ],
    }),
  );

  // 5 · Emphasis that repeats
  slides.push(
    slide({
      slideId: sid("motionrepeat"),
      title: "Emphasis that repeats",
      bg: D.bg,
      transition: { enter: "slide", "enter-duration": "0.6" },
      notes: "repeat runs an emphasis effect several times back to back. The bell pulses three times, the ring spins twice at a constant speed, the star grows twice with an overshoot.",
      effects: [
        fx(id("rbell"), "emphasis", "pulse", "on-click", { duration: "0.5", repeat: "3" }),
        fx(id("rring"), "emphasis", "spin", "on-click", { duration: "0.9", repeat: "2", easing: "linear" }),
        fx(id("rstar"), "emphasis", "grow", "on-click", { duration: "0.6", repeat: "2", easing: "overshoot" }),
      ],
      body: [
        kicker("rkick", 96, 92, "REPEAT"),
        el("rhead", "Heading", bold(96, 150, 50, D.ink, "Emphasis that repeats")),
        el(
          "rbell",
          "Bell",
          `<circle cx="0" cy="0" r="86" fill="${D.card}" stroke="${D.amber}" stroke-width="4"/><path d="M-34 22 L34 22 L26 10 L26 -14 A26 26 0 0 0 -26 -14 L-26 10 Z" fill="${D.amber}"/><circle cx="0" cy="34" r="9" fill="${D.amber}"/>`,
          { transform: "translate(300 380)", label: "A bell, pulsing three times" },
        ),
        el(
          "rring",
          "Ring",
          `<circle cx="0" cy="0" r="86" fill="${D.card}" stroke="${D.line}" stroke-width="4"/><path d="M0 -60 A60 60 0 0 1 60 0" fill="none" stroke="${D.cyan}" stroke-width="14" stroke-linecap="round"/>`,
          { transform: "translate(640 380)", label: "A loading ring, spinning twice" },
        ),
        el(
          "rstar",
          "Star",
          `<circle cx="0" cy="0" r="86" fill="${D.card}" stroke="${D.red}" stroke-width="4"/><path d="M0 -52 L15 -16 L54 -16 L23 8 L34 46 L0 24 L-34 46 L-23 8 L-54 -16 L-15 -16 Z" fill="${D.red}"/>`,
          { transform: "translate(980 380)", label: "A star, growing twice" },
        ),
        el(
          "rlabels",
          "Labels",
          [
            [300, "pulse", 'repeat="3"'],
            [640, "spin", 'repeat="2" linear'],
            [980, "grow", 'repeat="2" overshoot'],
          ]
            .map(
              ([x, effect, detail]) =>
                `${text(x, 514, 24, D.ink, effect, ` text-anchor="middle" font-family="${MONO}"`)}${text(x, 548, 18, D.muted, detail, ` text-anchor="middle" font-family="${MONO}"`)}`,
            )
            .join(""),
        ),
        darkFooter(),
      ],
    }),
  );

  // 6 · Triggers: a quiz whose answers reveal themselves
  const options = [
    ["qzip", "ZIP", "qzipno", "Only legacy decks, formatVersion 1–4.", D.red, "✗"],
    ["qsql", "SQLite", "qsqlyes", "Right: one SQLite file, one row per path.", D.green, "✓"],
    ["qpdf", "PDF", "qpdfno", "No: every slide is live SVG.", D.red, "✗"],
  ];
  slides.push(
    slide({
      slideId: sid("motionquizes"),
      title: "Quiz: which container holds a deck?",
      bg: D.bg,
      transition: { enter: "fade", "enter-duration": "0.5" },
      notes:
        "Each answer is a trigger: clicking it reveals its own verdict without advancing the slide. Click outside the answers (or press →) to move on. Triggers are keyboard-reachable too: Tab to an answer and press Enter.",
      effects: options.map(([key, , verdict]) => fx(id(verdict), "enter", "zoom", "on-click", { duration: "0.4", easing: "overshoot", trigger: id(key) })),
      body: [
        kicker("qkick", 96, 92, "TRIGGERS"),
        el("qhead", "Heading", bold(96, 150, 50, D.ink, "Which container holds a .slidra deck?")),
        el("qhint", "Hint", text(96, 200, 22, D.faint, "Click an answer. It reveals its verdict and the slide stays put.")),
        ...options.flatMap(([key, label, verdict, message, color, mark], i) => {
          const y = 260 + i * 120;
          return [
            el(key, `Answer ${label}`, `<rect x="0" y="0" width="300" height="90" rx="16" fill="${D.card}" stroke="${D.line}" stroke-width="2"/>${bold(32, 58, 34, D.ink, label)}`, {
              transform: `translate(96 ${y})`,
            }),
            el(verdict, `Verdict ${label}`, `<circle cx="45" cy="45" r="30" fill="${color}"/>${text(45, 57, 32, "#ffffff", mark, ' text-anchor="middle"')}${text(96, 55, 26, D.ink, message)}`, {
              transform: `translate(430 ${y})`,
            }),
          ];
        }),
        darkFooter(),
      ],
    }),
  );

  // 7–9 · Morph: the same ids in new places
  const stages = [
    ["mwrite", "Write", D.blue],
    ["mcheck", "Check", D.amber],
    ["mplay", "Play", D.red],
  ];
  const morphSlide = (n, { heading, headingTransform, caption, bg, layout, notes }) =>
    slide({
      slideId: sid(`motionmorph${n}`),
      title: `Morph, step ${n}`,
      bg,
      transition: n === 1 ? { enter: "fade", "enter-duration": "0.5" } : { enter: "morph", "enter-duration": "1.1" },
      notes,
      body: [
        el("mhead", "Heading", bold(0, 0, 50, D.ink, heading), { transform: headingTransform }),
        ...stages.map(([key, label, color], i) => {
          const [x, y, w, h] = layout[i];
          return el(
            key,
            `Stage ${label}`,
            `<rect x="0" y="0" width="${w}" height="${h}" rx="${Math.min(w, h) / 6}" fill="${color}"/>${bold(w / 2, h / 2 + 14, Math.max(26, Math.round(h / 4)), "#ffffff", label, ' text-anchor="middle"')}`,
            { transform: `translate(${x} ${y})` },
          );
        }),
        el(`mcap${n}`, "Caption", text(96, 640, 24, D.muted, caption)),
      ],
    });
  slides.push(
    morphSlide(1, {
      heading: "Morph: same ids, new places",
      headingTransform: "translate(96 150)",
      caption: "Three stages in a row. Press → : the next slide uses the same element ids.",
      bg: D.bg,
      layout: [
        [96, 260, 300, 160],
        [440, 260, 300, 160],
        [784, 260, 300, 160],
      ],
      notes: 'Slides 7, 8 and 9 share the ids of the heading and the three stages. The next two slides arrive with enter="morph": every shared element moves and resizes from where it was.',
    }),
    morphSlide(2, {
      heading: "Positions and sizes interpolate",
      headingTransform: "translate(96 110) scale(0.8)",
      caption: "A new layout, a new background colour, the same elements.",
      bg: D.bg2,
      layout: [
        [150, 200, 220, 120],
        [480, 300, 320, 170],
        [880, 420, 300, 160],
      ],
      notes: "Morph pairs elements by id. The heading shrank and moved, the stages went down a staircase, and the background colour blended.",
    }),
    morphSlide(3, {
      heading: "One file, from draft to podium",
      headingTransform: "translate(96 330) scale(0.78)",
      caption: "Elements only on one side fade in or out; the rest travel.",
      bg: D.bg,
      layout: [
        [760, 110, 420, 140],
        [760, 290, 420, 140],
        [760, 470, 420, 140],
      ],
      notes: "Last morph: the stages stack on the right, the heading moves to the middle left. The captions have different ids on each slide, so each one fades out and the next fades in.",
    }),
  );

  // 10 · Try it: keys and links
  const keys = [
    ["P", "Presenter view in a second window"],
    ["L", "Laser pointer"],
    ["Z", "Magnify around the pointer"],
    ["B", "Black screen"],
    ["Ctrl + P", "Print, PDF or images"],
    ["?", "Every key"],
  ];
  slides.push(
    slide({
      slideId: sid("motiontryit"),
      title: "Try it yourself",
      bg: D.bg,
      transition: { enter: "zoom", "enter-duration": "0.6" },
      notes: 'The two buttons are links. "Back to the start" goes to the first slide; "Read the playback spec" opens GitHub in a new tab.',
      effects: [fx(id("ykeys"), "enter", "fade", "on-click", { duration: "0.3", by: "line", stagger: "0.12" })],
      body: [
        kicker("ykick", 96, 92, "YOUR TURN"),
        el("yhead", "Heading", bold(96, 150, 50, D.ink, "Try it yourself")),
        el(
          "ykeys",
          "Keys",
          `<text font-size="26" fill="${D.ink}">${keys.map(([key, what], i) => `<tspan x="96" y="${240 + i * 52}" font-family="${MONO}" fill="${D.red}">${esc(key)}</tspan><tspan x="260" y="${240 + i * 52}">${esc(what)}</tspan>`).join("")}</text>`,
        ),
        el(
          "ystart",
          "Back to the start",
          `<rect x="0" y="0" width="340" height="80" rx="40" fill="${D.card}" stroke="${D.line}" stroke-width="2"/>${text(170, 50, 26, D.ink, "← Back to the start", ' text-anchor="middle"')}`,
          { transform: "translate(800 250)", extra: ' data-slidra-link="#first"' },
        ),
        el(
          "yspec",
          "Read the playback spec",
          `<rect x="0" y="0" width="340" height="80" rx="40" fill="${D.red}"/>${text(170, 50, 26, "#ffffff", "Read the playback spec ↗", ' text-anchor="middle"')}`,
          { transform: "translate(800 360)", extra: ' data-slidra-link="https://github.com/Noopher-AI/slidra/blob/main/spec/playback.md"' },
        ),
        darkFooter(),
      ],
    }),
  );

  return {
    project: {
      name: "Motion in .slidra",
      lang: "en",
      author: "Slidra",
      created: "2026-09-26T09:00:00Z",
      modified: "2026-09-26T09:00:00Z",
      description: "A tour of easing, fly directions, text builds, repeats, triggers, morph and links in the open .slidra format.",
      keywords: ["slidra", "animation", "morph", "example"],
      cover: "slides/001.svg",
    },
    slides,
  };
}

// ─── Sharing (light) ───────────────────────────────────────────────────

const L = { bg: "#fbf9f8", card: "#ffffff", ink: "#1f1a1a", muted: "#6e635f", faint: "#9a8f8c", line: "#ece5e2", red: "#c8233b", tint: "#fde8ea", blue: "#2f6fed", green: "#2f8f5b" };

const lightFooter = () =>
  el(
    "lfooter",
    "Footer",
    `<line x1="96" y1="660" x2="1184" y2="660" stroke="${L.line}" stroke-width="1.5"/>${text(96, 692, 16, L.faint, "{{ presentation_name }}")}${text(1184, 692, 16, L.faint, "{{ slide_number }} / {{ slide_total }}", ' text-anchor="end"')}`,
  );
const lkicker = (key, label) => el(key, "Kicker", text(96, 92, 16, L.red, label, ' font-weight="700" letter-spacing="3.5"'));
const lhead = (key, content) => el(key, "Heading", bold(96, 158, 48, L.ink, content));
const backLink = () =>
  el(
    "lback",
    "Back to the agenda",
    `<rect x="0" y="0" width="220" height="48" rx="24" fill="${L.card}" stroke="${L.line}" stroke-width="1.5"/>${text(110, 31, 18, L.muted, "← Agenda", ' text-anchor="middle"')}`,
    { transform: "translate(964 60)", extra: ` data-slidra-link="#${sid("shareagenda")}"` },
  );

function sharing(deckSlideCounts) {
  const slides = [];

  // 1 · Cover
  const dots = [];
  for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) dots.push(`<circle cx="${c * 40}" cy="${r * 40}" r="4" fill="#d9cfcb"/>`);
  slides.push(
    slide({
      slideId: sid("sharecover"),
      title: "Accessible, linked, ready to share",
      bg: L.bg,
      transition: { enter: "fade", "enter-duration": "0.8" },
      notes: "The second tour deck. This one is about who can read a deck and where it can go: screen readers, links between slides, the presenter view, printing, images and embedding.",
      body: [
        el("cdots", "Dots", dots.join(""), { transform: "translate(940 230)", extra: ' data-slidra-decorative="true"' }),
        el("cbar", "Accent bar", `<rect x="96" y="200" width="48" height="6" rx="3" fill="${L.red}"/>`, { extra: ' data-slidra-decorative="true"' }),
        el("ckick", "Kicker", text(96, 250, 16, L.red, "WHAT'S NEW · SHARING", ' font-weight="700" letter-spacing="3.5"')),
        el("ctitle", "Title", `${bold(96, 350, 76, L.ink, "Accessible, linked,")}${bold(96, 440, 76, L.ink, "ready to share.")}`),
        el("csub", "Subtitle", text(98, 510, 30, L.muted, "無障礙、可連結、隨時分享。", ' xml:lang="zh-Hant-TW"')),
        lightFooter(),
      ],
    }),
  );

  // 2 · Agenda: every row links to its slide
  const agenda = [
    ["shareimage", "Pictures that speak", "Alt text and decorative marks"],
    ["sharechart", "Charts carry their data", "A chart a screen reader can read"],
    ["sharelang", "語言標示", "Each slide says its language"],
    ["sharepresen", "Rehearse with the presenter view", "Notes, timer, next slide"],
    ["sharenetwk", "Nothing loads without you", "Network resources wait for consent"],
    ["sharetake", "Take it with you", "Print, PDF, images, embed"],
  ];
  slides.push(
    slide({
      slideId: sid("shareagenda"),
      title: "Agenda",
      bg: L.bg,
      transition: { enter: "slide", "enter-duration": "0.6" },
      notes: "Every row is a data-slidra-link to a slide id (#s-…). Click a row, or press Tab to reach it and Enter to follow it. Each of those slides has a link back here.",
      body: [
        lkicker("akick", "AGENDA · EVERY ROW IS A LINK"),
        lhead("ahead", "Where this deck goes"),
        ...agenda.map(([target, title, desc], i) => {
          const y = 206 + i * 70;
          return el(
            `arow${i}`,
            `Agenda ${title}`,
            `<rect x="0" y="0" width="1088" height="58" rx="12" fill="${L.card}" stroke="${L.line}" stroke-width="1.5"/>${text(28, 38, 20, L.red, String(i + 1).padStart(2, "0"), ` font-family="${MONO}" font-weight="700"`)}${text(84, 38, 26, L.ink, title, target === "sharelang" ? ' xml:lang="zh-Hant-TW"' : "")}${text(1060, 38, 20, L.muted, `${desc}  →`, ' text-anchor="end"')}`,
            { transform: `translate(96 ${y})`, extra: ` data-slidra-link="#${sid(target)}"` },
          );
        }),
        lightFooter(),
      ],
    }),
  );

  // 3 · Alt text
  slides.push(
    slide({
      slideId: sid("shareimage"),
      title: "Pictures that speak",
      bg: L.bg,
      transition: { enter: "fade", "enter-duration": "0.5" },
      notes:
        "The diagram carries a <title> and a <desc>, so a screen reader announces what it shows; the ornaments carry data-slidra-decorative and are skipped. During playback the title becomes an aria-label, so it never pops up as a tooltip.",
      body: [
        backLink(),
        lkicker("ikick", "ALT TEXT"),
        lhead("ihead", "Pictures that speak"),
        el("idiagram", "Diagram", `<image href="../assets/container-diagram.svg" x="96" y="200" width="620" height="400"/>`, {
          label: "Diagram: one .slidra file holds project.json, the slides, the assets and the fonts",
          desc: "A single SQLite file drawn as a box, with four labelled rows inside: project.json, slides/, assets/ and fonts/.",
        }),
        el("iorn", "Ornament", `<circle cx="1170" cy="580" r="54" fill="${L.tint}"/><circle cx="1170" cy="580" r="12" fill="${L.red}"/>`, { extra: ' data-slidra-decorative="true"' }),
        el(
          "ibody",
          "Explanation",
          `<text font-size="24" fill="${L.ink}"><tspan x="770" y="250">Give an image a &lt;title&gt;</tspan><tspan x="770" y="286">(and a &lt;desc&gt;, if it needs one).</tspan><tspan x="770" y="346" fill="${L.muted}">Mark ornaments</tspan><tspan x="770" y="382" fill="${L.muted}">data-slidra-decorative.</tspan><tspan x="770" y="442" fill="${L.muted}">slidra-validate flags</tspan><tspan x="770" y="478" fill="${L.muted}">every image with neither.</tspan></text>`,
          { extra: ' data-slidra-text-width="360"' },
        ),
        lightFooter(),
      ],
    }),
  );

  // 4 · A chart with its data
  const decks = Object.entries(deckSlideCounts);
  const max = Math.max(...decks.map(([, n]) => n));
  const bars = decks
    .map(([name, n], i) => {
      const y = 40 + i * 80;
      const w = Math.round((n / max) * 460);
      return `${text(0, y + 34, 22, L.ink, name)}<rect x="170" y="${y}" width="${w}" height="50" rx="8" fill="${i === decks.length - 1 ? L.red : L.blue}"/>${text(170 + w + 14, y + 34, 22, L.muted, String(n), ` font-family="${MONO}"`)}`;
    })
    .join("");
  slides.push(
    slide({
      slideId: sid("sharechart"),
      title: "Charts carry their data",
      bg: L.bg,
      transition: { enter: "slide", "enter-duration": "0.6" },
      notes: `The chart stores its numbers in <slidra:chart> next to the drawing, so tools and screen readers get the data, not just bars. These are the real slide counts of the example decks: ${decks.map(([n, c]) => `${n} ${c}`).join(", ")}.`,
      effects: [fx(id("hchart"), "enter", "fly-right", "on-click", { duration: "0.6", easing: "ease-out" })],
      body: [
        backLink(),
        lkicker("hkick", "CHARTS"),
        lhead("hhead", "Charts carry their data"),
        `  <g id="${id("hchart")}" data-slidra-name="Slides per example deck" data-slidra-type="chart" transform="translate(96 210)"><title>Slides in each example deck</title><desc>${esc(decks.map(([n, c]) => `${n}: ${c}`).join(", "))}</desc>\n    <slidra:chart xmlns:slidra="${NS}" type="hbar" width="720" height="${decks.length * 80 + 40}" legend="none" labels="true">\n      <slidra:series name="Slides" values="${decks.map(([, n]) => n).join(",")}"/>\n      <slidra:categories values="${decks.map(([n]) => n).join(",")}"/>\n    </slidra:chart>\n    <svg width="720" height="${decks.length * 80 + 40}" viewBox="0 0 720 ${decks.length * 80 + 40}">${bars}</svg>\n  </g>`,
        el(
          "hnote",
          "Note",
          `<text font-size="22" fill="${L.muted}"><tspan x="880" y="260">Slides in each</tspan><tspan x="880" y="292">example deck,</tspan><tspan x="880" y="324">counted when</tspan><tspan x="880" y="356">this deck was built.</tspan></text>`,
          { extra: ' data-slidra-text-width="300"' },
        ),
        lightFooter(),
      ],
    }),
  );

  // 5 · Language: a Traditional Chinese slide
  slides.push(
    slide({
      slideId: sid("sharelang"),
      title: "語言標示",
      bg: L.bg,
      lang: "zh-Hant-TW",
      transition: { enter: "fade", "enter-duration": "0.5" },
      notes:
        'This slide sets xml:lang="zh-Hant-TW" on its root, overriding the deck\'s lang (en). The viewer gives the slide\'s frame <html lang="zh-Hant-TW">, so a screen reader switches to a Chinese voice here.',
      effects: [fx(id("zbody"), "enter", "fade", "on-click", { duration: "0.4", by: "line", stagger: "0.3" })],
      body: [
        backLink(),
        el("zkick", "Kicker", text(96, 92, 16, L.red, "語言 · LANGUAGE", ' font-weight="700" letter-spacing="3.5"')),
        el("zhead", "Heading", bold(96, 158, 48, L.ink, "每張投影片都說明自己的語言")),
        el(
          "zbody",
          "Body",
          `<text font-size="30" fill="${L.ink}"><tspan x="96" y="260">整份 deck 在 project.json 標示 lang="en"，</tspan><tspan x="96" y="320" data-slidra-break="true">這一張則以 xml:lang="zh-Hant-TW" 覆寫。</tspan><tspan x="96" y="380" data-slidra-break="true">螢幕閱讀器會因此改用中文語音朗讀。</tspan></text>`,
          { extra: ' data-slidra-text-width="1000"' },
        ),
        el(
          "zcode",
          "Code",
          `<rect x="96" y="440" width="780" height="80" rx="12" fill="${L.ink}"/>${text(124, 490, 22, "#f4f6f8", '<svg … xml:lang="zh-Hant-TW">', ` font-family="${MONO}" xml:space="preserve"`)}`,
        ),
        lightFooter(),
      ],
    }),
  );

  // 6 · Presenter view
  const presenterSteps = ["Press P to open the presenter view.", "Drag this window to the projector, press F.", "Your notes, the timer and the next slide stay with you."];
  slides.push(
    slide({
      slideId: sid("sharepresen"),
      title: "Rehearse with the presenter view",
      bg: L.bg,
      transition: { enter: "slide", "enter-duration": "0.6" },
      notes:
        'These are the notes the presenter view shows you, in large type you can resize with A− and A+.\nThe timer starts when the view opens; Pause and Reset are next to it.\nThe "Next" box shows what the next click reveals: here, the next line of the list.',
      effects: presenterSteps.map((_, i) => fx(id(`pstep${i}`), "enter", "fly-left", "on-click", { duration: "0.45", easing: "ease-out" })),
      body: [
        backLink(),
        lkicker("pkick", "PRESENTER VIEW"),
        lhead("phead", "Rehearse with the presenter view"),
        ...presenterSteps.map((line, i) =>
          el(
            `pstep${i}`,
            `Step ${i + 1}`,
            `<circle cx="20" cy="-9" r="20" fill="${L.red}"/>${text(20, -1, 20, "#ffffff", String(i + 1), ' text-anchor="middle" font-weight="700"')}${text(64, 0, 30, L.ink, line)}`,
            { transform: `translate(96 ${270 + i * 90})` },
          ),
        ),
        el("pnote", "Note", text(96, 590, 22, L.muted, "The audience window never shows the notes while the presenter view is open.")),
        lightFooter(),
      ],
    }),
  );

  // 7 · Network consent
  slides.push(
    slide({
      slideId: sid("sharenetwk"),
      title: "Nothing loads from the internet until you say so",
      bg: L.bg,
      transition: { enter: "fade", "enter-duration": "0.5" },
      notes:
        'The logo on this slide is the only thing in these example decks that comes from the network. The viewer shows a notice and loads nothing until you press "Load external content"; even one remote image would tell its server that you opened the deck.',
      body: [
        backLink(),
        lkicker("nkick", "PRIVACY"),
        lhead("nhead", "Nothing loads without you"),
        el(
          "nframe",
          "Frame",
          `<rect x="96" y="210" width="360" height="360" rx="20" fill="${L.card}" stroke="${L.line}" stroke-width="1.5"/>${text(276, 400, 20, L.faint, "loads after consent", ' text-anchor="middle"')}`,
          { extra: ' data-slidra-decorative="true"' },
        ),
        el("nlogo", "Remote logo", `<image href="https://github.com/Noopher-AI.png" x="136" y="250" width="280" height="280"/>`, { label: "The Noopher AI logo, loaded from github.com" }),
        el(
          "nbody",
          "Explanation",
          `<text font-size="26" fill="${L.ink}"><tspan x="520" y="260">This logo comes from github.com.</tspan><tspan x="520" y="310" fill="${L.muted}">The viewer blocks it in the slide's</tspan><tspan x="520" y="346" fill="${L.muted}">Content-Security-Policy and asks first.</tspan><tspan x="520" y="410" fill="${L.muted}">Press "Load external content" in the</tspan><tspan x="520" y="446" fill="${L.muted}">notice at the top to see it.</tspan></text>`,
          { extra: ' data-slidra-text-width="620"' },
        ),
        lightFooter(),
      ],
    }),
  );

  // 8 · Take it with you
  /** @type {[string, string[]][]} */
  const ways = [
    ["Print or PDF", ["Ctrl + P or ⌘ + P", "slides, notes pages,", "handouts, every step"]],
    ["Images", ["The current slide as PNG,", "or all slides", "as a ZIP of PNGs"]],
    ["Embed", ['<iframe src="…/embed', '?deck=…">', "plus oEmbed and previews"]],
  ];
  slides.push(
    slide({
      slideId: sid("sharetake"),
      title: "Take it with you",
      bg: L.bg,
      transition: { enter: "slide", "enter-duration": "0.6" },
      notes: "Ctrl+P (or the printer button) opens Print or export. Links to decks on a Slidra server preview their cover slide in chat apps, and /embed puts a deck on any other site.",
      effects: ways.map((_, i) => fx(id(`way${i}`), "enter", "zoom", i === 0 ? "on-click" : "after-previous", { duration: "0.4", easing: "overshoot" })),
      body: [
        backLink(),
        lkicker("wkick", "SHARE"),
        lhead("whead", "Take it with you"),
        ...ways.map(([title, lines], i) =>
          el(
            `way${i}`,
            `Way ${title}`,
            `<rect x="0" y="0" width="340" height="330" rx="20" fill="${L.card}" stroke="${L.line}" stroke-width="1.5"/>${bold(32, 70, 34, L.ink, title)}${lines.map((line, j) => text(32, 140 + j * 44, 22, L.muted, line, title === "Embed" && j < 2 ? ` font-family="${MONO}"` : "")).join("")}`,
            { transform: `translate(${96 + i * 374} 230)` },
          ),
        ),
        lightFooter(),
      ],
    }),
  );

  // 9 · Closing
  slides.push(
    slide({
      slideId: sid("sharethanks"),
      title: "Thank you",
      bg: L.bg,
      transition: { enter: "fade", "enter-duration": "0.8" },
      notes: "Links: back to the agenda, back to the start, and the repository on GitHub.",
      body: [
        el("tbar", "Accent bar", `<rect x="96" y="228" width="48" height="6" rx="3" fill="${L.red}"/>`, { extra: ' data-slidra-decorative="true"' }),
        el("tthanks", "Thanks", bold(90, 360, 110, L.ink, "Thank you.")),
        el("tthanksz", "Thanks in Chinese", text(98, 440, 36, L.muted, "謝謝收看", ' xml:lang="zh-Hant-TW"')),
        el(
          "tagenda",
          "Back to the agenda",
          `<rect x="0" y="0" width="260" height="64" rx="32" fill="${L.card}" stroke="${L.line}" stroke-width="1.5"/>${text(130, 41, 22, L.ink, "← Agenda", ' text-anchor="middle"')}`,
          { transform: "translate(96 500)", extra: ` data-slidra-link="#${sid("shareagenda")}"` },
        ),
        el(
          "tfirst",
          "Back to the start",
          `<rect x="0" y="0" width="260" height="64" rx="32" fill="${L.card}" stroke="${L.line}" stroke-width="1.5"/>${text(130, 41, 22, L.ink, "⇤ First slide", ' text-anchor="middle"')}`,
          { transform: "translate(376 500)", extra: ' data-slidra-link="#first"' },
        ),
        el("trepo", "The repository", `<rect x="0" y="0" width="320" height="64" rx="32" fill="${L.red}"/>${text(160, 41, 22, "#ffffff", "Source on GitHub ↗", ' text-anchor="middle"')}`, {
          transform: "translate(656 500)",
          extra: ' data-slidra-link="https://github.com/Noopher-AI/slidra"',
        }),
        lightFooter(),
      ],
    }),
  );

  return {
    project: {
      name: "Accessible, linked, ready to share",
      lang: "en",
      author: "Slidra",
      created: "2026-09-26T09:00:00Z",
      modified: "2026-09-26T09:00:00Z",
      description: "Metadata, links between slides, alt text, charts with data, slide languages, the presenter view, network consent, and printing, images and embedding in the open .slidra format.",
      keywords: ["slidra", "accessibility", "presenter view", "example"],
      cover: "slides/001.svg",
    },
    slides,
    assets: {
      "assets/container-diagram.svg": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 620 400"><rect x="10" y="10" width="600" height="380" rx="24" fill="#ffffff" stroke="#1f1a1a" stroke-width="3"/><text x="40" y="62" font-family="${MONO}" font-size="24" font-weight="700" fill="#c8233b">talk.slidra</text><text x="580" y="62" font-family="system-ui, sans-serif" font-size="18" fill="#9a8f8c" text-anchor="end">one SQLite file</text>${["project.json", "slides/", "assets/", "fonts/"].map((row, i) => `<rect x="40" y="${96 + i * 70}" width="540" height="54" rx="10" fill="${i === 1 ? "#fde8ea" : "#fbf9f8"}" stroke="#ece5e2" stroke-width="2"/><text x="64" y="${131 + i * 70}" font-family="${MONO}" font-size="22" fill="#1f1a1a">${row}</text>`).join("")}</svg>`,
    },
  };
}

// ─── Write ─────────────────────────────────────────────────────────────

function write(file, { project, slides, assets = {} }) {
  const deck = new DeckWriter(project);
  slides.forEach((source) => deck.addSlide(source));
  for (const [entry, data] of Object.entries(assets)) deck.addFile(entry, data);
  if (fontPath && boldPath) {
    const license = licensePath && existsSync(licensePath) ? readFileSync(licensePath) : undefined;
    const common = { license: "SIL Open Font License 1.1", licenseFile: "fonts/LICENSE-NotoSansTC.txt", source: "https://fonts.google.com/noto/specimen/Noto+Sans+TC" };
    deck.addFont({ file: "fonts/NotoSansTC-Regular.otf", family: "Noto Sans TC", ...common }, readFileSync(fontPath), license);
    deck.addFont({ file: "fonts/NotoSansTC-Bold.otf", family: "Noto Sans TC Bold", ...common }, readFileSync(boldPath), license);
  }
  deck.write(file);
}

mkdirSync(OUT, { recursive: true });
const motionDeck = motion();
const counts = { Showcase: 7, Minimal: 10, Motion: motionDeck.slides.length };
const sharingDeck = sharing({ ...counts, Sharing: 9 });
if (sharingDeck.slides.length !== 9) throw new Error(`the sharing deck has ${sharingDeck.slides.length} slides; update its count in the chart`);

write(path.join(OUT, "motion.slidra"), motionDeck);
write(path.join(OUT, "sharing.slidra"), sharingDeck);
// Every character the decks use, for subsetting the embedded fonts.
writeFileSync(path.join(ROOT, "tools", ".feature-text.txt"), [...motionDeck.slides, ...sharingDeck.slides, ...Object.values(sharingDeck.assets)].join("\n"));
console.log(
  `wrote ${path.relative(process.cwd(), path.join(OUT, "motion.slidra"))}, ${path.relative(process.cwd(), path.join(OUT, "sharing.slidra"))}${fontPath ? "" : " (no fonts: pass --font and --bold)"}`,
);
