// Builds the example decks under examples/ — a maintainer tool, not part of
// the viewer. Needs Node >= 22.5 (node:sqlite).
//
//   node --no-warnings tools/build-examples.mjs [--font path/to/font.ttf] [--media dir]
//
// --font  an OFL font to embed (subset it first to keep the deck small)
// --out   where to write the decks (default: examples/)
// --media a directory holding intro.webm / narration.oga for the media slide

import { readFileSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DeckWriter } from "../lib/writer/index.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NS = "https://slidra.app/ns/2026";
const args = process.argv.slice(2);
const argValue = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};
const OUT = argValue("--out") ? path.resolve(argValue("--out")) : path.join(ROOT, "examples");
const fontPath = argValue("--font");
const mediaDir = argValue("--media");

// ─── Container writers ─────────────────────────────────────────────────

/** Writes a formatVersion 5 deck through the reference writer (lib/writer/). */
function writeSqliteDeck(file, entries) {
  const { slides, ...fields } = JSON.parse(String(entries.find(([entryPath]) => entryPath === "project.json")[1]));
  const deck = new DeckWriter(fields);
  for (const [entryPath, data] of entries) {
    if (entryPath === "project.json" || slides.includes(entryPath)) continue;
    if (data === null) deck.addDirectory(entryPath);
    else deck.addFile(entryPath, data);
  }
  for (const slide of slides) deck.addSlide(entries.find(([entryPath]) => entryPath === slide)[1], { path: slide });
  deck.write(file);
}

function project(name, slides, extra = {}) {
  return JSON.stringify({ formatVersion: 5, name, canvas: { width: 1280, height: 720 }, slides, ...extra }, null, 2) + "\n";
}

// ─── Slide helpers ─────────────────────────────────────────────────────

const esc = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const FONT = "Noto Sans TC, PingFang TC, Microsoft JhengHei, system-ui, sans-serif";

function effect(target, family, name, start, extra = {}) {
  const attrs = Object.entries(extra)
    .map(([k, v]) => ` ${k}="${esc(v)}"`)
    .join("");
  return `<slidra:effect target="${target}" family="${family}" effect="${name}" start="${start}"${attrs}/>`;
}

function slide({ bg = "#14161a", effects = [], transition = null, notes = "", body }) {
  const meta = [];
  if (effects.length) meta.push(`<slidra:effects xmlns:slidra="${NS}">\n      ${effects.join("\n      ")}\n    </slidra:effects>`);
  if (transition) {
    const attrs = Object.entries(transition)
      .map(([k, v]) => ` ${k}="${v}"`)
      .join("");
    meta.push(`<slidra:transition xmlns:slidra="${NS}"${attrs}/>`);
  }
  if (notes) meta.push(`<slidra:notes xmlns:slidra="${NS}">${esc(notes)}</slidra:notes>`);
  const metadata = meta.length ? `  <metadata>\n    ${meta.join("\n    ")}\n  </metadata>\n` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720" style="background-color:${bg}" font-family="${FONT}">\n${metadata}${body}\n</svg>\n`;
}

const id = (name) => `el-${name.padEnd(12, "0").slice(0, 12)}`;

function text(elId, name, x, y, size, fill, content, extra = "") {
  return `  <g id="${elId}" data-slidra-name="${esc(name)}">\n    <text x="${x}" y="${y}" font-size="${size}" fill="${fill}"${extra}>${esc(content)}</text>\n  </g>`;
}

function footer() {
  return `  <g id="${id("footer")}" data-slidra-name="Footer">\n    <text x="64" y="684" font-size="18" fill="#6b7280">{{ presentation_name }}</text>\n    <text x="1216" y="684" font-size="18" fill="#6b7280" text-anchor="end">{{ slide_number }} / {{ slide_total }}</text>\n  </g>`;
}

const RED = "#c8233b";
const INK = "#f4f6f8";
const MUTED = "#a9b0b8";

// ─── Showcase deck ─────────────────────────────────────────────────────

function showcase() {
  const slides = [];

  // 1 · Title
  slides.push(
    slide({
      bg: "#101216",
      transition: { enter: "fade", "enter-duration": "0.8", exit: "fade", "exit-duration": "0.4" },
      notes: "Welcome. Everything you are looking at lives inside one .slidra file: a SQLite database with SVG slides.\nPress → or click to step through.",
      effects: [
        effect(id("kicker"), "enter", "fade", "on-click", { duration: "0.5" }),
        effect(id("title"), "enter", "zoom", "with-previous", { duration: "0.8" }),
        effect(id("subtitle"), "enter", "fly-up", "after-previous", { duration: "0.6" }),
        effect(id("rule"), "enter", "fly-left", "with-previous", { duration: "0.6", delay: "0.1" }),
      ],
      body: [
        `  <g id="${id("glow")}" data-slidra-name="Glow">\n    <defs><radialGradient id="g1" cx="0.78" cy="0.2" r="0.7"><stop offset="0" stop-color="${RED}" stop-opacity="0.35"/><stop offset="1" stop-color="${RED}" stop-opacity="0"/></radialGradient></defs>\n    <rect width="1280" height="720" fill="url(#g1)"/>\n  </g>`,
        text(id("kicker"), "Kicker", 96, 250, 22, RED, "OPEN FORMAT · OPEN VIEWER", ' letter-spacing="4" font-weight="700"'),
        `  <g id="${id("title")}" data-slidra-name="Title" transform="translate(96 360)">\n    <text x="0" y="0" font-size="112" font-weight="700" fill="${INK}">Slidra</text>\n  </g>`,
        text(id("subtitle"), "Subtitle", 100, 440, 40, MUTED, "一個檔案，就是整份簡報。"),
        `  <g id="${id("rule")}" data-slidra-name="Rule">\n    <rect x="100" y="480" width="160" height="6" rx="3" fill="${RED}"/>\n  </g>`,
        footer(),
      ].join("\n"),
    }),
  );

  // 2 · What is inside
  const rows = [
    ["project.json", "name · canvas · slide order · fonts"],
    ["slides/001.svg …", "one self-contained SVG per slide"],
    ["assets/", "images, video, audio, CSV data"],
    ["fonts/", "embedded fonts + their licences"],
  ];
  slides.push(
    slide({
      transition: { enter: "slide", "enter-duration": "0.6", exit: "slide", "exit-duration": "0.4" },
      notes: "The container is one SQLite table called content: one row per virtual path. Each row here enters on its own click.",
      effects: rows.map((_, i) => effect(id(`row${i}`), "enter", "fly-left", i === 0 ? "on-click" : "on-click", { duration: "0.5" })),
      body: [
        text(id("h2"), "Heading", 96, 150, 56, INK, "What is inside a .slidra", ' font-weight="700"'),
        text(id("h2sub"), "Sub", 96, 200, 26, MUTED, "CREATE TABLE content (id, path, kind, data)"),
        ...rows.map(
          ([name, desc], i) =>
            `  <g id="${id(`row${i}`)}" data-slidra-name="Row ${i + 1}" transform="translate(96 ${250 + i * 96})">\n    <rect x="0" y="0" width="1088" height="76" rx="12" fill="#1c1f26" stroke="#2a2e37"/>\n    <rect x="0" y="0" width="8" height="76" rx="4" fill="${RED}"/>\n    <text x="36" y="48" font-size="28" fill="${INK}" font-family="ui-monospace, Menlo, monospace">${esc(name)}</text>\n    <text x="1052" y="48" font-size="24" fill="${MUTED}" text-anchor="end">${esc(desc)}</text>\n  </g>`,
        ),
        footer(),
      ].join("\n"),
    }),
  );

  // 3 · Effects gallery
  const enters = ["appear", "fade", "fly-up", "fly-left", "zoom"];
  const emph = ["pulse", "spin", "grow"];
  const exits = ["disappear", "fade-out", "zoom-out"];
  const card = (key, label, x, y, color) =>
    `  <g id="${id(key)}" data-slidra-name="${label}" transform="translate(${x} ${y})">\n    <rect x="-80" y="-44" width="160" height="88" rx="14" fill="${color}"/>\n    <text x="0" y="10" font-size="24" fill="#fff" text-anchor="middle" font-weight="700">${label}</text>\n  </g>`;
  slides.push(
    slide({
      transition: { enter: "zoom", "enter-duration": "0.5", exit: "fade", "exit-duration": "0.3" },
      notes: "Step 1: five entrances chained with-previous and after-previous.\nStep 2: three emphasis effects together.\nStep 3: three exits.",
      effects: [
        effect(id("en0"), "enter", "appear", "on-click", { duration: "0.3" }),
        ...enters.slice(1).map((name, i) => effect(id(`en${i + 1}`), "enter", name, "after-previous", { duration: "0.45" })),
        effect(id("em0"), "emphasis", "pulse", "on-click", { duration: "0.8" }),
        effect(id("em1"), "emphasis", "spin", "with-previous", { duration: "1" }),
        effect(id("em2"), "emphasis", "grow", "with-previous", { duration: "0.8" }),
        effect(id("ex0"), "exit", "disappear", "on-click", { duration: "0.3" }),
        effect(id("ex1"), "exit", "fade-out", "with-previous", { duration: "0.6", delay: "0.2" }),
        effect(id("ex2"), "exit", "zoom-out", "after-previous", { duration: "0.6" }),
      ],
      body: [
        text(id("h3"), "Heading", 96, 120, 52, INK, "Effects: enter · emphasis · exit", ' font-weight="700"'),
        text(id("lab1"), "Label enter", 96, 205, 20, MUTED, "ENTER", ' letter-spacing="3"'),
        ...enters.map((name, i) => card(`en${i}`, name, 200 + i * 220, 290, "#2b6cb0")),
        text(id("lab2"), "Label emphasis", 96, 395, 20, MUTED, "EMPHASIS", ' letter-spacing="3"'),
        ...emph.map((name, i) => card(`em${i}`, name, 200 + i * 220, 480, "#b7791f")),
        text(id("lab3"), "Label exit", 96, 585, 20, MUTED, "EXIT", ' letter-spacing="3"'),
        ...exits.map((name, i) => card(`ex${i}`, name, 200 + i * 220, 640, RED)),
        `  <g id="${id("hint3")}" data-slidra-name="Hint">\n    <text x="1216" y="640" font-size="20" fill="${MUTED}" text-anchor="end">3 clicks on this slide</text>\n  </g>`,
      ].join("\n"),
    }),
  );

  // 4 · Motion path
  const d = "M0 0 C 220 -260, 520 260, 760 0 S 980 -120, 900 -200";
  slides.push(
    slide({
      bg: "#0f1115",
      transition: { enter: "fade", "enter-duration": "0.5" },
      notes: 'family="path": the element follows SVG path data, relative to where it already sits.',
      effects: [effect(id("ball"), "path", "path", "on-click", { duration: "2.4", d }), effect(id("ball"), "emphasis", "pulse", "after-previous", { duration: "0.5" })],
      body: [
        text(id("h4"), "Heading", 96, 120, 52, INK, "Motion paths", ' font-weight="700"'),
        text(id("h4s"), "Sub", 96, 168, 24, MUTED, "Any SVG path, sampled into keyframes"),
        `  <g id="${id("track")}" data-slidra-name="Track" transform="translate(220 460)">\n    <path d="${d}" fill="none" stroke="#3a3f4b" stroke-width="3" stroke-dasharray="10 10"/>\n  </g>`,
        `  <g id="${id("ball")}" data-slidra-name="Ball" transform="translate(220 460)">\n    <circle cx="0" cy="0" r="30" fill="${RED}"/>\n    <circle cx="-9" cy="-9" r="9" fill="#ff8a9b"/>\n  </g>`,
        footer(),
      ].join("\n"),
    }),
  );

  // 5 · Chart + table
  const values = [
    [42, 55, 61, 78],
    [30, 36, 48, 52],
  ];
  const cats = ["Q1", "Q2", "Q3", "Q4"];
  const barW = 36;
  const chartBars = cats
    .map(
      (cat, c) =>
        values
          .map((series, s) => {
            const h = series[c] * 3;
            const x = 50 + c * 105 + s * (barW + 6);
            return `<rect x="${x}" y="${280 - h}" width="${barW}" height="${h}" rx="4" fill="${s === 0 ? RED : "#5b6dea"}"/>`;
          })
          .join("") + `<text x="${50 + c * 105 + barW + 3}" y="306" font-size="16" fill="${MUTED}" text-anchor="middle">${cat}</text>`,
    )
    .join("");
  const colW = [150, 110, 110];
  const rowH = 52;
  const tableRows = [
    ["Region", "Units", "Growth"],
    ["Taipei", "1,280", "+18%"],
    ["Tokyo", "960", "+11%"],
    ["Berlin", "740", "+7%"],
  ];
  const cells = tableRows
    .map((row, r) =>
      row
        .map((value, c) => {
          const x = colW.slice(0, c).reduce((a, b) => a + b, 0);
          const header = r === 0;
          return `<g data-slidra-cell="${r},${c}" transform="translate(${x} ${r * rowH})"><rect x="0" y="0" width="${colW[c]}" height="${rowH}" fill="${header ? "#262a33" : r % 2 ? "#1a1d23" : "#1f232a"}"/><text x="14" y="33" fill="${header ? MUTED : INK}" font-size="20"${header ? ' font-weight="700"' : ""}><tspan>${esc(value)}</tspan></text></g>`;
        })
        .join(""),
    )
    .join("\n    ");
  slides.push(
    slide({
      transition: { enter: "slide", "enter-duration": "0.6" },
      notes: "Charts and tables use the exception shape: data plus the rendered SVG in one container. The viewer only needs the rendered SVG.",
      effects: [effect(id("chart"), "enter", "zoom", "on-click", { duration: "0.7" }), effect(id("table"), "enter", "fade", "after-previous", { duration: "0.6" })],
      body: [
        text(id("h5"), "Heading", 96, 120, 52, INK, "Charts & tables", ' font-weight="700"'),
        `  <g id="${id("chart")}" data-slidra-name="Chart" data-slidra-type="chart" transform="translate(96 200)">\n    <slidra:chart xmlns:slidra="${NS}" type="bar" stacked="false" axes="single" palette="brand" legend="none" grid="true" labels="false" x-title="" y-title="" width="480" height="320">\n      <slidra:series name="Revenue" values="${values[0].join(",")}" axis="left"/>\n      <slidra:series name="Costs" values="${values[1].join(",")}" axis="left"/>\n      <slidra:categories values="${cats.join(",")}"/>\n    </slidra:chart>\n    <svg width="480" height="320" viewBox="0 0 480 320"><rect width="480" height="320" rx="12" fill="#1a1d23"/><g stroke="#2a2e37"><line x1="40" y1="280" x2="460" y2="280"/><line x1="40" y1="190" x2="460" y2="190"/><line x1="40" y1="100" x2="460" y2="100"/></g>${chartBars}</svg>\n  </g>`,
        `  <g id="${id("table")}" data-slidra-name="Table" data-slidra-type="table" data-slidra-cols="${colW.join(" ")}" data-slidra-rows="${tableRows.map(() => rowH).join(" ")}" data-slidra-header="1" data-slidra-theme="dark" transform="translate(700 230)">\n    ${cells}\n  </g>`,
        footer(),
      ].join("\n"),
    }),
  );

  // 6 · Media
  const hasMedia = mediaDir && existsSync(path.join(mediaDir, "intro.webm"));
  if (hasMedia) {
    slides.push(
      slide({
        transition: { enter: "fade", "enter-duration": "0.5" },
        notes: "The video plays on the first click (a media effect). The audio clip has no effect, so it gets a play button.",
        effects: [effect(id("video"), "media", "play", "on-click")],
        body: [
          text(id("h6"), "Heading", 96, 120, 52, INK, "Media", ' font-weight="700"'),
          text(id("h6s"), "Sub", 96, 168, 24, MUTED, "Click to play the video · the audio has its own button"),
          `  <g id="${id("video")}" data-slidra-name="Video" data-slidra-media="../assets/intro.webm" data-slidra-type="video">\n    <rect x="96" y="220" width="640" height="360" rx="8" fill="#262a33"/>\n  </g>`,
          `  <g id="${id("audio")}" data-slidra-name="Narration" data-slidra-media="../assets/narration.oga" data-slidra-type="audio">\n    <rect x="800" y="220" width="384" height="160" rx="12" fill="#1c1f26" stroke="#2a2e37"/>\n    <text x="992" y="355" font-size="20" fill="${MUTED}" text-anchor="middle">narration.oga</text>\n  </g>`,
          `  <g id="${id("photo")}" data-slidra-name="Photo">\n    <image href="../assets/badge.svg" x="800" y="410" width="384" height="170"/>\n  </g>`,
          footer(),
        ].join("\n"),
      }),
    );
  }

  // 7 · Closing
  slides.push(
    slide({
      bg: "#101216",
      transition: { enter: "zoom", "enter-duration": "0.7" },
      notes: "Spec: spec/slidra-format.md and spec/playback.md. Viewer: npm start, then open http://localhost:8080/.",
      effects: [
        effect(id("thanks"), "enter", "zoom", "on-click", { duration: "0.7" }),
        effect(id("links"), "enter", "fade", "after-previous", { duration: "0.5" }),
        effect(id("thanks"), "emphasis", "pulse", "on-click", { duration: "0.6" }),
      ],
      body: [
        `  <g id="${id("thanks")}" data-slidra-name="Thanks" transform="translate(640 330)">\n    <text x="0" y="0" font-size="120" font-weight="700" fill="${INK}" text-anchor="middle">謝謝 · Thanks</text>\n  </g>`,
        `  <g id="${id("links")}" data-slidra-name="Links">\n    <text x="640" y="430" font-size="30" fill="${MUTED}" text-anchor="middle">spec/slidra-format.md · spec/playback.md</text>\n    <text x="640" y="480" font-size="26" fill="${RED}" text-anchor="middle" font-family="ui-monospace, Menlo, monospace">npm start → localhost:8080</text>\n  </g>`,
        footer(),
      ].join("\n"),
    }),
  );

  const entries = [];
  const slidePaths = slides.map((_, i) => `slides/${String(i + 1).padStart(3, "0")}.svg`);
  entries.push(["slides", null], ["assets", null], ["fonts", null]);
  const extra = {};
  if (fontPath) {
    entries.push(["fonts/NotoSansTC-Presentation.ttf", readFileSync(fontPath)]);
    const licence = path.join(path.dirname(fontPath), "LICENSE-NotoSansTC.txt");
    if (existsSync(licence)) entries.push(["fonts/LICENSE-NotoSansTC.txt", readFileSync(licence)]);
    extra.fonts = [
      {
        file: "fonts/NotoSansTC-Presentation.ttf",
        family: "Noto Sans TC",
        license: "SIL Open Font License 1.1",
        licenseFile: "fonts/LICENSE-NotoSansTC.txt",
        source: "https://fonts.google.com/noto/specimen/Noto+Sans+TC",
      },
    ];
  }
  if (hasMedia) {
    entries.push(["assets/intro.webm", readFileSync(path.join(mediaDir, "intro.webm"))]);
    entries.push(["assets/narration.oga", readFileSync(path.join(mediaDir, "narration.oga"))]);
  }
  entries.push([
    "assets/badge.svg",
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 384 170"><rect width="384" height="170" rx="12" fill="#c8233b"/><text x="192" y="100" font-size="34" font-family="system-ui, sans-serif" font-weight="700" fill="#fff" text-anchor="middle">assets/badge.svg</text></svg>`,
  ]);
  slides.forEach((markup, i) => entries.push([slidePaths[i], markup]));
  entries.push(["project.json", project("Slidra Showcase", slidePaths, extra)]);
  return { entries, text: slides.join("\n") };
}

// ─── Minimal deck: a light, minimalist theme ───────────────────────────

const M = {
  bg: "#fbf9f8",
  card: "#ffffff",
  ink: "#1f1a1a",
  muted: "#6e635f",
  faint: "#9a8f8c",
  line: "#ece5e2",
  grid: "#f3edea",
  red: RED,
  tint: "#fde8ea",
  mono: "ui-monospace, Menlo, Consolas, monospace",
};

function mText(x, y, size, fill, content, extra = "") {
  return `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}"${extra}>${esc(content)}</text>`;
}

function mEl(key, name, inner, transform = "") {
  const t = transform ? ` transform="${transform}"` : "";
  return `  <g id="${id(key)}" data-slidra-name="${esc(name)}"${t}>\n    ${inner}\n  </g>`;
}

function mFooter() {
  return mEl(
    "mfooter",
    "Footer",
    [
      `<line x1="96" y1="660" x2="1184" y2="660" stroke="${M.line}" stroke-width="1.5"/>`,
      `<text x="96" y="692" font-size="16" fill="${M.faint}">{{ presentation_name }}</text>`,
      `<text x="1184" y="692" font-size="16" fill="${M.faint}" text-anchor="end">{{ slide_number }} / {{ slide_total }}</text>`,
    ].join("\n    "),
  );
}

function mKicker(key, x, y, label, fill = M.red) {
  return mEl(key, "Kicker", mText(x, y, 16, fill, label, ' font-weight="700" letter-spacing="3.5"'));
}

function mHeading(title) {
  return mEl("mhead", "Heading", mText(96, 158, 48, M.ink, title, ' font-weight="700"'));
}

/** Donut arc between two angles (radians, 0 = 12 o'clock). */
function arc(cx, cy, r0, r1, a0, a1) {
  const p = (r, a) => `${(cx + r * Math.sin(a)).toFixed(2)} ${(cy - r * Math.cos(a)).toFixed(2)}`;
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M${p(r1, a0)} A${r1} ${r1} 0 ${large} 1 ${p(r1, a1)} L${p(r0, a1)} A${r0} ${r0} 0 ${large} 0 ${p(r0, a0)} Z`;
}

function minimal(showcaseEntries) {
  const slides = [];
  const bg = M.bg;

  // 1 · Cover
  const dots = [];
  for (let r = 0; r < 6; r++) {
    for (let c = 0; c < 6; c++) {
      if (r === 2 && c === 3) continue;
      dots.push(`<circle cx="${c * 44}" cy="${r * 44}" r="3.5" fill="#d9cfcb"/>`);
    }
  }
  slides.push(
    slide({
      bg,
      transition: { enter: "fade", "enter-duration": "0.8", exit: "fade", "exit-duration": "0.4" },
      notes: "A minimalist sample deck. Everything here is plain SVG with numbers for positions. Click once: the red dot pulses.",
      effects: [effect(id("mdot"), "emphasis", "pulse", "on-click", { duration: "0.8" }), effect(id("mdot"), "emphasis", "grow", "after-previous", { duration: "0.6" })],
      body: [
        mEl("mbar", "Accent bar", `<rect x="96" y="196" width="48" height="6" rx="3" fill="${M.red}"/>`),
        mKicker("mkick", 96, 244, "SLIDRA · MINIMAL THEME"),
        mEl(
          "mtitle",
          "Title",
          `<text x="96" y="344" font-size="80" font-weight="700" fill="${M.ink}">Slides are pictures</text>\n    <text x="96" y="432" font-size="80" font-weight="700" fill="${M.ink}">with <tspan fill="${M.red}">coordinates.</tspan></text>`,
        ),
        mEl("msub", "Subtitle", mText(98, 500, 30, M.muted, "投影片，就是一張有座標的圖。")),
        mEl("mgrid", "Dot grid", dots.join(""), "translate(900 230)"),
        mEl("mdot", "Red dot", `<circle cx="0" cy="0" r="9" fill="${M.red}"/>`, "translate(1032 318)"),
        mEl(
          "maxis",
          "Axis labels",
          `${mText(900, 520, 15, M.faint, "x →", ` font-family="${M.mono}"`)}${mText(868, 244, 15, M.faint, "y", ` font-family="${M.mono}"`)}${mText(1044, 300, 15, M.red, "(132, 88)", ` font-family="${M.mono}"`)}`,
        ),
        mEl("mcredit", "Credit", mText(96, 620, 18, M.faint, "A sample deck in the open .slidra format")),
      ].join("\n"),
    }),
  );

  // 2 · Agenda
  const agenda = [
    ["One fixed canvas", "Every slide is 1280 × 720"],
    ["Position is stated", "No hidden layout engine"],
    ["Checks are arithmetic", "Align, space, fit, overlap"],
    ["Motion is data", "Effects are declared, not scripted"],
  ];
  slides.push(
    slide({
      bg,
      transition: { enter: "slide", "enter-duration": "0.6", exit: "slide", "exit-duration": "0.4" },
      notes: "Four ideas. Each row enters after the previous one.",
      effects: agenda.map((_, i) => effect(id(`magenda${i}`), "enter", "fly-left", i === 0 ? "on-click" : "after-previous", { duration: "0.45" })),
      body: [
        mKicker("mkick", 96, 92, "AGENDA"),
        mHeading("Four ideas behind the format"),
        ...agenda.map(([title, desc], i) => {
          const y = 262 + i * 92;
          return mEl(
            `magenda${i}`,
            `Agenda ${i + 1}`,
            [
              mText(96, y, 22, M.red, String(i + 1).padStart(2, "0"), ` font-family="${M.mono}" font-weight="700"`),
              mText(168, y, 32, M.ink, title, ' font-weight="700"'),
              mText(1184, y, 22, M.muted, desc, ' text-anchor="end"'),
              `<line x1="96" y1="${y + 30}" x2="1184" y2="${y + 30}" stroke="${M.line}" stroke-width="1.5"/>`,
            ].join("\n    "),
          );
        }),
        mFooter(),
      ].join("\n"),
    }),
  );

  // 3 · Big number
  slides.push(
    slide({
      bg,
      transition: { enter: "zoom", "enter-duration": "0.6" },
      notes: "Every slide in a deck shares one canvas, declared once in project.json.",
      effects: [effect(id("mbig"), "enter", "zoom", "on-click", { duration: "0.7" }), effect(id("mcaption"), "enter", "fly-up", "after-previous", { duration: "0.5" })],
      body: [
        mKicker("mkick", 100, 214, "THE CANVAS"),
        mEl("mbig", "Big number", `<text x="90" y="410" font-size="190" font-weight="700" fill="${M.ink}" letter-spacing="-4">1280<tspan fill="${M.red}" font-weight="400"> × </tspan>720</text>`),
        mEl(
          "mcaption",
          "Caption",
          [
            mText(100, 492, 32, M.muted, "One canvas. Every element is placed on it by number."),
            mText(100, 540, 22, M.faint, '"canvas": { "width": 1280, "height": 720 }', ` font-family="${M.mono}"`),
          ].join("\n    "),
        ),
        mFooter(),
      ].join("\n"),
    }),
  );

  // 4 · Two columns
  const column = (key, x, dark, label, title, code, note) => {
    const fg = dark ? "#ffffff" : M.ink;
    const sub = dark ? "#b4a9a6" : M.muted;
    return mEl(
      key,
      label,
      [
        `<rect x="${x}" y="206" width="520" height="410" rx="18" fill="${dark ? M.ink : M.card}" stroke="${dark ? M.ink : M.line}" stroke-width="1.5"/>`,
        mText(x + 40, 262, 16, dark ? "#ff8a9b" : M.red, label, ' font-weight="700" letter-spacing="3"'),
        mText(x + 40, 318, 36, fg, title, ' font-weight="700"'),
        `<rect x="${x + 40}" y="352" width="440" height="128" rx="10" fill="${dark ? "#2b2424" : M.bg}"/>`,
        ...code.map((line, i) => mText(x + 64, 396 + i * 32, 19, dark ? "#f4f6f8" : M.ink, line, ` font-family="${M.mono}" xml:space="preserve"`)),
        ...note.map((line, i) => mText(x + 40, 534 + i * 32, 21, sub, line)),
      ].join("\n    "),
    );
  };
  slides.push(
    slide({
      bg,
      transition: { enter: "fade", "enter-duration": "0.5" },
      notes: "The same title, two ways. In HTML its position depends on everything around it; in SVG it is two numbers.",
      effects: [effect(id("mleft"), "enter", "fly-up", "on-click", { duration: "0.5" }), effect(id("mright"), "enter", "fly-up", "on-click", { duration: "0.5" })],
      body: [
        mKicker("mkick", 96, 92, "COMPARE"),
        mHeading("Where does the title end up?"),
        column(
          "mleft",
          96,
          false,
          "HTML + CSS",
          "Position is emergent",
          ['<h1 class="title">', "  Quarterly Review", "</h1>"],
          ["…it depends on fonts, the viewport,", "the flow and every element before it."],
        ),
        column("mright", 664, true, "SVG", "Position is stated", ['<text x="96" y="160">', "  Quarterly Review", "</text>"], ["…it is exactly (96, 160).", "Nothing else will move it."]),
        mFooter(),
      ].join("\n"),
    }),
  );

  // 5 · Coordinate diagram
  const gx = 96;
  const gy = 196;
  const gridLines = [];
  for (let x = 40; x < 640; x += 40) gridLines.push(`<line x1="${gx + x}" y1="${gy}" x2="${gx + x}" y2="${gy + 360}" stroke="${M.grid}"/>`);
  for (let y = 40; y < 360; y += 40) gridLines.push(`<line x1="${gx}" y1="${gy + y}" x2="${gx + 640}" y2="${gy + y}" stroke="${M.grid}"/>`);
  const bx = gx + 96;
  const by = gy + 80;
  slides.push(
    slide({
      bg,
      transition: { enter: "slide", "enter-duration": "0.6", exit: "fade", "exit-duration": "0.3" },
      notes: "The diagram is the canvas at half scale. The box's edges come straight from its attributes, so fitting on the canvas is two additions.",
      effects: [
        effect(id("mbox"), "enter", "zoom", "on-click", { duration: "0.5" }),
        effect(id("mdims"), "enter", "fade", "after-previous", { duration: "0.5" }),
        effect(id("mcode"), "enter", "fly-left", "on-click", { duration: "0.5" }),
        effect(id("mcheck"), "enter", "fly-up", "after-previous", { duration: "0.5" }),
      ],
      body: [
        mKicker("mkick", 96, 92, "GEOMETRY"),
        mHeading("Read the layout straight from the file"),
        mEl(
          "mcanvas",
          "Canvas",
          [
            `<rect x="${gx}" y="${gy}" width="640" height="360" rx="6" fill="${M.card}" stroke="#d9cfcb" stroke-width="1.5"/>`,
            ...gridLines,
            mText(gx + 632, gy + 352, 13, M.faint, "1280 × 720 (½ scale)", ` text-anchor="end" font-family="${M.mono}"`),
          ].join("\n    "),
        ),
        mEl(
          "mbox",
          "Box",
          `<rect x="0" y="0" width="240" height="120" rx="8" fill="${M.tint}" stroke="${M.red}" stroke-width="2.5"/>\n    ${mText(120, 68, 20, M.red, "el-hero", ` text-anchor="middle" font-family="${M.mono}" font-weight="700"`)}`,
          `translate(${bx} ${by})`,
        ),
        mEl(
          "mdims",
          "Dimensions",
          [
            `<line x1="${gx}" y1="${by + 60}" x2="${bx}" y2="${by + 60}" stroke="${M.ink}" stroke-dasharray="4 4"/>`,
            mText(gx + 8, by + 52, 14, M.ink, "x 192", ` font-family="${M.mono}"`),
            `<line x1="${bx + 120}" y1="${gy}" x2="${bx + 120}" y2="${by}" stroke="${M.ink}" stroke-dasharray="4 4"/>`,
            mText(bx + 128, gy + 46, 14, M.ink, "y 160", ` font-family="${M.mono}"`),
            `<path d="M${bx} ${by + 140} v8 M${bx} ${by + 144} H${bx + 240} M${bx + 240} ${by + 140} v8" stroke="${M.ink}" fill="none"/>`,
            mText(bx + 120, by + 168, 14, M.ink, "width 480", ` text-anchor="middle" font-family="${M.mono}"`),
            `<path d="M${bx + 260} ${by} h8 M${bx + 264} ${by} V${by + 120} M${bx + 260} ${by + 120} h8" stroke="${M.ink}" fill="none"/>`,
            mText(bx + 276, by + 66, 14, M.ink, "height 240", ` font-family="${M.mono}"`),
          ].join("\n    "),
        ),
        mEl(
          "mcode",
          "Markup",
          [
            mText(790, 250, 16, M.faint, "IN THE FILE", ' font-weight="700" letter-spacing="3"'),
            `<rect x="790" y="270" width="394" height="92" rx="10" fill="${M.ink}"/>`,
            mText(812, 308, 18, "#f4f6f8", '<rect x="192" y="160"', ` font-family="${M.mono}" xml:space="preserve"`),
            mText(812, 338, 18, "#f4f6f8", '      width="480" height="240"/>', ` font-family="${M.mono}" xml:space="preserve"`),
          ].join("\n    "),
        ),
        mEl(
          "mcheck",
          "Checks",
          [
            mText(790, 420, 16, M.faint, "SO THE CHECK IS", ' font-weight="700" letter-spacing="3"'),
            mText(790, 462, 20, M.ink, "right   192 + 480 = 672 ≤ 1280", ` font-family="${M.mono}" xml:space="preserve"`),
            mText(790, 498, 20, M.ink, "bottom  160 + 240 = 400 ≤ 720", ` font-family="${M.mono}" xml:space="preserve"`),
            mText(790, 546, 22, M.red, "Fits the canvas.", ' font-weight="700"'),
          ].join("\n    "),
        ),
        mFooter(),
      ].join("\n"),
    }),
  );

  // 6 · Four checks
  /** @type {[string, string, string[]][]} */
  const checks = [
    ["Align", "a.x == b.x", ["Left edges share", "one number."]],
    ["Space", "b.y − (a.y + a.h)", ["The gap is a", "subtraction."]],
    ["Fit", "x + w ≤ 1280", ["Inside the canvas,", "or it is not."]],
    ["Overlap", "a ∩ b = ∅", ["Compare intervals", "on both axes."]],
  ];
  slides.push(
    slide({
      bg,
      transition: { enter: "fade", "enter-duration": "0.5" },
      notes: "Because positions are numbers, these checks need no screenshot: a program, or a model, can compute them from the document.",
      effects: checks.map((_, i) => effect(id(`mcard${i}`), "enter", "zoom", i === 0 ? "on-click" : "after-previous", { duration: "0.4" })),
      body: [
        mKicker("mkick", 96, 92, "VALIDATION"),
        mHeading("Checks become arithmetic"),
        ...checks.map(([title, formula, desc], i) => {
          const x = 96 + i * 278;
          return mEl(
            `mcard${i}`,
            `Check ${title}`,
            [
              `<rect x="0" y="0" width="252" height="380" rx="18" fill="${M.card}" stroke="${M.line}" stroke-width="1.5"/>`,
              mText(28, 56, 18, M.red, String(i + 1).padStart(2, "0"), ` font-family="${M.mono}" font-weight="700"`),
              mText(28, 128, 38, M.ink, title, ' font-weight="700"'),
              `<rect x="28" y="160" width="196" height="54" rx="8" fill="${M.bg}"/>`,
              mText(126, 194, 18, M.ink, formula, ` text-anchor="middle" font-family="${M.mono}"`),
              ...desc.map((line, j) => mText(28, 272 + j * 30, 20, M.muted, line)),
            ].join("\n    "),
            `translate(${x} 216)`,
          );
        }),
        mFooter(),
      ].join("\n"),
    }),
  );

  // 7 · Quote (dark, for rhythm)
  slides.push(
    slide({
      bg: M.ink,
      transition: { enter: "fade", "enter-duration": "0.8", exit: "fade", "exit-duration": "0.5" },
      notes: "The one design principle to remember: no second layout layer on top of SVG.",
      effects: [effect(id("mquote"), "enter", "fade", "on-click", { duration: "0.8" }), effect(id("mattrib"), "enter", "fly-up", "after-previous", { duration: "0.5" })],
      body: [
        mEl("mmark", "Quote mark", mText(84, 300, 240, M.red, "“", ' font-weight="700"')),
        mEl(
          "mquote",
          "Quote",
          `${mText(96, 360, 60, "#ffffff", "The slide is the artifact —", ' font-weight="700"')}\n    ${mText(96, 438, 60, "#ffffff", "not a description of one.", ' font-weight="700"')}`,
        ),
        mEl("mattrib", "Attribution", [`<rect x="96" y="500" width="48" height="4" rx="2" fill="${M.red}"/>`, mText(160, 508, 22, "#b4a9a6", ".slidra design principle")].join("\n    ")),
      ].join("\n"),
    }),
  );

  // 8 · Timeline
  /** @type {[string, string[]][]} */
  const stages = [
    ["Prompt", ["A model writes SVG", "at stated coordinates"]],
    ["Draft", ["Every object gets", "a stable el- id"]],
    ["Review", ["Geometry is checked", "from the file itself"]],
    ["Present", ["Any viewer plays it,", "animations included"]],
  ];
  const tx = (i) => 196 + i * 296;
  slides.push(
    slide({
      bg,
      transition: { enter: "slide", "enter-duration": "0.6" },
      notes: "Click once: the marker travels the whole timeline along a motion path, then pulses.",
      effects: [
        effect(id("mmarker"), "path", "path", "on-click", { duration: "2.4", d: `M0 0 L${tx(3) - tx(0)} 0` }),
        effect(id("mmarker"), "emphasis", "pulse", "after-previous", { duration: "0.6" }),
      ],
      body: [
        mKicker("mkick", 96, 92, "WORKFLOW"),
        mHeading("One deck, from prompt to podium"),
        mEl(
          "mline",
          "Timeline",
          [
            `<line x1="${tx(0)}" y1="400" x2="${tx(3)}" y2="400" stroke="#d9cfcb" stroke-width="3"/>`,
            ...stages.map(([label, desc], i) =>
              [
                `<circle cx="${tx(i)}" cy="400" r="11" fill="${M.card}" stroke="${M.ink}" stroke-width="3"/>`,
                mText(tx(i), 352, 30, M.ink, label, ' text-anchor="middle" font-weight="700"'),
                ...desc.map((line, j) => mText(tx(i), 458 + j * 30, 19, M.muted, line, ' text-anchor="middle"')),
              ].join("\n    "),
            ),
          ].join("\n    "),
        ),
        mEl("mmarker", "Marker", `<circle cx="0" cy="0" r="15" fill="${M.red}"/>\n    <circle cx="0" cy="0" r="5" fill="#ffffff"/>`, `translate(${tx(0)} 400)`),
        mFooter(),
      ].join("\n"),
    }),
  );

  // 9 · Donut chart, measured from the showcase deck
  /** @type {[string, (p: string) => boolean, string][]} */
  const groups = [
    ["Media", (p) => p.startsWith("assets/") && /\.(webm|oga)$/.test(p), M.red],
    ["Fonts", (p) => p.startsWith("fonts/"), M.ink],
    ["Slides", (p) => p.startsWith("slides/"), "#b4a9a6"],
    ["Other", () => true, "#e5dcd8"],
  ];
  const totals = groups.map(() => 0);
  for (const [p, data] of showcaseEntries) {
    if (data === null) continue;
    const size = typeof data === "string" ? Buffer.byteLength(data) : data.length;
    totals[groups.findIndex(([, test]) => test(p))] += size;
  }
  const sum = totals.reduce((a, b) => a + b, 0);
  const cx = 356;
  const cy = 424;
  let angle = 0;
  const arcs = totals.map((value, i) => {
    const sweep = (value / sum) * Math.PI * 2;
    const d = arc(cx - 136, cy - 216, 104, 168, angle + 0.012, angle + sweep - 0.012);
    angle += sweep;
    return `<path d="${d}" fill="${groups[i][2]}"/>`;
  });
  const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
  slides.push(
    slide({
      bg,
      transition: { enter: "zoom", "enter-duration": "0.6" },
      notes: "Real numbers: byte sizes of the entries inside examples/showcase.slidra, grouped by type. Media dominates; the subset font is small.",
      effects: [
        effect(id("mchart"), "enter", "zoom", "on-click", { duration: "0.7" }),
        ...groups.map((_, i) => effect(id(`mlegend${i}`), "enter", "fly-left", "after-previous", { duration: "0.35" })),
      ],
      body: [
        mKicker("mkick", 96, 92, "BY THE NUMBERS"),
        mHeading("What's inside the showcase deck"),
        `  <g id="${id("mchart")}" data-slidra-name="Donut chart" data-slidra-type="chart" transform="translate(136 216)">\n    <slidra:chart xmlns:slidra="${NS}" type="donut" legend="none" labels="false" width="440" height="400">\n      <slidra:series name="Bytes" values="${totals.join(",")}"/>\n      <slidra:categories values="${groups.map(([n]) => n).join(",")}"/>\n    </slidra:chart>\n    <svg width="440" height="400" viewBox="0 0 440 400">${arcs.join("")}<text x="220" y="202" font-size="44" font-weight="700" fill="${M.ink}" text-anchor="middle">${esc(kb(sum))}</text><text x="220" y="236" font-size="18" fill="${M.muted}" text-anchor="middle">total content</text></svg>\n  </g>`,
        ...groups.map(([name, , color], i) =>
          mEl(
            `mlegend${i}`,
            `Legend ${name}`,
            [
              `<rect x="0" y="-18" width="22" height="22" rx="5" fill="${color}"/>`,
              mText(40, 0, 28, M.ink, name, ' font-weight="700"'),
              mText(440, 0, 24, M.muted, kb(totals[i]), ` text-anchor="end" font-family="${M.mono}"`),
              mText(540, 0, 24, i === 0 ? M.red : M.ink, `${Math.round((totals[i] / sum) * 100)}%`, ' text-anchor="end" font-weight="700"'),
              `<line x1="0" y1="24" x2="540" y2="24" stroke="${M.line}" stroke-width="1.5"/>`,
            ].join("\n    "),
            `translate(644 ${300 + i * 72})`,
          ),
        ),
        mEl("msource", "Source", mText(644, 604, 16, M.faint, "Measured from examples/showcase.slidra at build time")),
        mFooter(),
      ].join("\n"),
    }),
  );

  // 10 · Closing
  slides.push(
    slide({
      bg,
      transition: { enter: "fade", "enter-duration": "0.8" },
      notes: "End of the sample. Open spec/slidra-format.md to see how every element on these slides is written.",
      effects: [effect(id("mthanks"), "enter", "fly-up", "on-click", { duration: "0.7" }), effect(id("mthanksb"), "enter", "fade", "after-previous", { duration: "0.5" })],
      body: [
        mEl("mbar", "Accent bar", `<rect x="96" y="228" width="48" height="6" rx="3" fill="${M.red}"/>`),
        mEl("mthanks", "Thanks", mText(90, 370, 120, M.ink, "Thank you.", ' font-weight="700" letter-spacing="-2"')),
        mEl(
          "mthanksb",
          "Thanks sub",
          [
            mText(98, 440, 36, M.muted, "謝謝收看"),
            mText(98, 540, 20, M.faint, "Read how every element here is written:", ""),
            mText(98, 576, 20, M.red, "spec/slidra-format.md", ` font-family="${M.mono}" font-weight="700"`),
          ].join("\n    "),
        ),
        mEl("mdotend", "Dot", `<circle cx="1120" cy="330" r="64" fill="${M.tint}"/><circle cx="1120" cy="330" r="14" fill="${M.red}"/>`),
        mFooter(),
      ].join("\n"),
    }),
  );

  const slidePaths = slides.map((_, i) => `slides/${String(i + 1).padStart(3, "0")}.svg`);
  /** @type {[string, string | Buffer | null][]} */
  const entries = [
    ["slides", null],
    ["assets", null],
    ["fonts", null],
  ];
  const extra = {};
  if (fontPath) {
    entries.push(["fonts/NotoSansTC-Presentation.ttf", readFileSync(fontPath)]);
    const licence = path.join(path.dirname(fontPath), "LICENSE-NotoSansTC.txt");
    if (existsSync(licence)) entries.push(["fonts/LICENSE-NotoSansTC.txt", readFileSync(licence)]);
    extra.fonts = [
      {
        file: "fonts/NotoSansTC-Presentation.ttf",
        family: "Noto Sans TC",
        license: "SIL Open Font License 1.1",
        licenseFile: "fonts/LICENSE-NotoSansTC.txt",
        source: "https://fonts.google.com/noto/specimen/Noto+Sans+TC",
      },
    ];
  }
  slides.forEach((markup, i) => entries.push([slidePaths[i], markup]));
  entries.push(["project.json", project("Slides with Coordinates", slidePaths, extra)]);
  return { entries, text: slides.join("\n") };
}

const deck = showcase();
const minimalDeck = minimal(deck.entries);
writeSqliteDeck(path.join(OUT, "showcase.slidra"), deck.entries);
writeSqliteDeck(path.join(OUT, "minimal.slidra"), minimalDeck.entries);
// Every glyph the example decks use, for subsetting the embedded font.
writeFileSync(path.join(ROOT, "tools", ".showcase-text.txt"), deck.text + minimalDeck.text);
console.log(`wrote ${path.relative(process.cwd(), path.join(OUT, "showcase.slidra"))}, ${path.relative(process.cwd(), path.join(OUT, "minimal.slidra"))}`);
