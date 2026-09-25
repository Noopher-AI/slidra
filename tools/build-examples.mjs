// Builds the example decks under examples/ — a maintainer tool, not part of
// the viewer. Needs Node >= 22.5 (node:sqlite).
//
//   node --no-warnings tools/build-examples.mjs [--font path/to/font.ttf] [--media dir]
//
// --font  an OFL font to embed (subset it first to keep the deck small)
// --media a directory holding intro.webm / narration.oga for the media slide

import { readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync, crc32 as zlibCrc32 } from "node:zlib";
import { DatabaseSync } from "node:sqlite";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "examples");
const NS = "https://slidra.app/ns/2026";
const args = process.argv.slice(2);
const argValue = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};
const fontPath = argValue("--font");
const mediaDir = argValue("--media");

// ─── Container writers ─────────────────────────────────────────────────

/** Writes a formatVersion 5 deck exactly as RFC 0001 describes it. */
function writeSqliteDeck(file, entries) {
  rmSync(file, { force: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = DELETE");
  db.exec("PRAGMA application_id = 1399612530"); // ASCII "Sldr"
  db.exec("PRAGMA user_version = 5");
  db.exec("CREATE TABLE content (\n    id INTEGER PRIMARY KEY,\n    path TEXT NOT NULL UNIQUE,\n    kind INTEGER NOT NULL,   -- 0 = file, 1 = directory\n    data BLOB                -- NULL for a directory row\n)");
  const insert = db.prepare("INSERT INTO content (path, kind, data) VALUES (?, ?, ?)");
  for (const dir of ["slides", "assets", "fonts"]) insert.run(dir, 1, null);
  for (const [entryPath, data] of entries) {
    if (data === null) {
      if (!["slides", "assets", "fonts"].includes(entryPath)) insert.run(entryPath, 1, null);
      continue;
    }
    insert.run(entryPath, 0, typeof data === "string" ? Buffer.from(data, "utf8") : data);
  }
  db.close();
}

/** Writes a legacy (formatVersion 1-4) ZIP deck. */
function writeZipDeck(file, entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, raw] of entries) {
    const isDir = raw === null;
    const entryName = Buffer.from(isDir ? `${name}/` : name, "utf8");
    const data = isDir ? Buffer.alloc(0) : Buffer.from(raw);
    const compressed = isDir ? data : deflateRawSync(data);
    const method = isDir ? 0 : 8;
    const crc = isDir ? 0 : zlibCrc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(entryName.length, 26);
    locals.push(local, entryName, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(entryName.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, entryName);
    offset += 30 + entryName.length + compressed.length;
  }
  const centralSize = centrals.reduce((sum, b) => sum + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  writeFileSync(file, Buffer.concat([...locals, ...centrals, end]));
}

function project(name, slides, extra = {}) {
  return JSON.stringify({ formatVersion: 5, name, canvas: { width: 1280, height: 720 }, slides, ...extra }, null, 2) + "\n";
}

// ─── Slide helpers ─────────────────────────────────────────────────────

const esc = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const FONT = "Noto Sans TC, PingFang TC, Microsoft JhengHei, system-ui, sans-serif";

function effect(target, family, name, start, extra = {}) {
  const attrs = Object.entries(extra).map(([k, v]) => ` ${k}="${esc(v)}"`).join("");
  return `<slidra:effect target="${target}" family="${family}" effect="${name}" start="${start}"${attrs}/>`;
}

function slide({ bg = "#14161a", effects = [], transition = null, notes = "", body }) {
  const meta = [];
  if (effects.length) meta.push(`<slidra:effects xmlns:slidra="${NS}">\n      ${effects.join("\n      ")}\n    </slidra:effects>`);
  if (transition) {
    const attrs = Object.entries(transition).map(([k, v]) => ` ${k}="${v}"`).join("");
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
  slides.push(slide({
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
  }));

  // 2 · What is inside
  const rows = [
    ["project.json", "name · canvas · slide order · fonts"],
    ["slides/001.svg …", "one self-contained SVG per slide"],
    ["assets/", "images, video, audio, CSV data"],
    ["fonts/", "embedded fonts + their licences"],
  ];
  slides.push(slide({
    transition: { enter: "slide", "enter-duration": "0.6", exit: "slide", "exit-duration": "0.4" },
    notes: "The container is one SQLite table called content: one row per virtual path. Each row here enters on its own click.",
    effects: rows.map((_, i) => effect(id(`row${i}`), "enter", "fly-left", i === 0 ? "on-click" : "on-click", { duration: "0.5" })),
    body: [
      text(id("h2"), "Heading", 96, 150, 56, INK, "What is inside a .slidra", ' font-weight="700"'),
      text(id("h2sub"), "Sub", 96, 200, 26, MUTED, "CREATE TABLE content (id, path, kind, data)"),
      ...rows.map(([name, desc], i) =>
        `  <g id="${id(`row${i}`)}" data-slidra-name="Row ${i + 1}" transform="translate(96 ${250 + i * 96})">\n    <rect x="0" y="0" width="1088" height="76" rx="12" fill="#1c1f26" stroke="#2a2e37"/>\n    <rect x="0" y="0" width="8" height="76" rx="4" fill="${RED}"/>\n    <text x="36" y="48" font-size="28" fill="${INK}" font-family="ui-monospace, Menlo, monospace">${esc(name)}</text>\n    <text x="1052" y="48" font-size="24" fill="${MUTED}" text-anchor="end">${esc(desc)}</text>\n  </g>`),
      footer(),
    ].join("\n"),
  }));

  // 3 · Effects gallery
  const enters = ["appear", "fade", "fly-up", "fly-left", "zoom"];
  const emph = ["pulse", "spin", "grow"];
  const exits = ["disappear", "fade-out", "zoom-out"];
  const card = (key, label, x, y, color) =>
    `  <g id="${id(key)}" data-slidra-name="${label}" transform="translate(${x} ${y})">\n    <rect x="-80" y="-44" width="160" height="88" rx="14" fill="${color}"/>\n    <text x="0" y="10" font-size="24" fill="#fff" text-anchor="middle" font-weight="700">${label}</text>\n  </g>`;
  slides.push(slide({
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
  }));

  // 4 · Motion path
  const d = "M0 0 C 220 -260, 520 260, 760 0 S 980 -120, 900 -200";
  slides.push(slide({
    bg: "#0f1115",
    transition: { enter: "fade", "enter-duration": "0.5" },
    notes: "family=\"path\": the element follows SVG path data, relative to where it already sits.",
    effects: [
      effect(id("ball"), "path", "path", "on-click", { duration: "2.4", d }),
      effect(id("ball"), "emphasis", "pulse", "after-previous", { duration: "0.5" }),
    ],
    body: [
      text(id("h4"), "Heading", 96, 120, 52, INK, "Motion paths", ' font-weight="700"'),
      text(id("h4s"), "Sub", 96, 168, 24, MUTED, "Any SVG path, sampled into keyframes"),
      `  <g id="${id("track")}" data-slidra-name="Track" transform="translate(220 460)">\n    <path d="${d}" fill="none" stroke="#3a3f4b" stroke-width="3" stroke-dasharray="10 10"/>\n  </g>`,
      `  <g id="${id("ball")}" data-slidra-name="Ball" transform="translate(220 460)">\n    <circle cx="0" cy="0" r="30" fill="${RED}"/>\n    <circle cx="-9" cy="-9" r="9" fill="#ff8a9b"/>\n  </g>`,
      footer(),
    ].join("\n"),
  }));

  // 5 · Chart + table
  const values = [[42, 55, 61, 78], [30, 36, 48, 52]];
  const cats = ["Q1", "Q2", "Q3", "Q4"];
  const barW = 36;
  const chartBars = cats.map((cat, c) => values.map((series, s) => {
    const h = series[c] * 3;
    const x = 50 + c * 105 + s * (barW + 6);
    return `<rect x="${x}" y="${280 - h}" width="${barW}" height="${h}" rx="4" fill="${s === 0 ? RED : "#5b6dea"}"/>`;
  }).join("") + `<text x="${50 + c * 105 + barW + 3}" y="306" font-size="16" fill="${MUTED}" text-anchor="middle">${cat}</text>`).join("");
  const colW = [150, 110, 110];
  const rowH = 52;
  const tableRows = [["Region", "Units", "Growth"], ["Taipei", "1,280", "+18%"], ["Tokyo", "960", "+11%"], ["Berlin", "740", "+7%"]];
  const cells = tableRows.map((row, r) => row.map((value, c) => {
    const x = colW.slice(0, c).reduce((a, b) => a + b, 0);
    const header = r === 0;
    return `<g data-slidra-cell="${r},${c}" transform="translate(${x} ${r * rowH})"><rect x="0" y="0" width="${colW[c]}" height="${rowH}" fill="${header ? "#262a33" : r % 2 ? "#1a1d23" : "#1f232a"}"/><text x="14" y="33" fill="${header ? MUTED : INK}" font-size="20"${header ? ' font-weight="700"' : ""}><tspan>${esc(value)}</tspan></text></g>`;
  }).join("")).join("\n    ");
  slides.push(slide({
    transition: { enter: "slide", "enter-duration": "0.6" },
    notes: "Charts and tables use the exception shape: data plus the rendered SVG in one container. The viewer only needs the rendered SVG.",
    effects: [
      effect(id("chart"), "enter", "zoom", "on-click", { duration: "0.7" }),
      effect(id("table"), "enter", "fade", "after-previous", { duration: "0.6" }),
    ],
    body: [
      text(id("h5"), "Heading", 96, 120, 52, INK, "Charts & tables", ' font-weight="700"'),
      `  <g id="${id("chart")}" data-slidra-name="Chart" data-slidra-type="chart" transform="translate(96 200)">\n    <slidra:chart xmlns:slidra="${NS}" type="bar" stacked="false" axes="single" palette="brand" legend="none" grid="true" labels="false" x-title="" y-title="" width="480" height="320">\n      <slidra:series name="Revenue" values="${values[0].join(",")}" axis="left"/>\n      <slidra:series name="Costs" values="${values[1].join(",")}" axis="left"/>\n      <slidra:categories values="${cats.join(",")}"/>\n    </slidra:chart>\n    <svg width="480" height="320" viewBox="0 0 480 320"><rect width="480" height="320" rx="12" fill="#1a1d23"/><g stroke="#2a2e37"><line x1="40" y1="280" x2="460" y2="280"/><line x1="40" y1="190" x2="460" y2="190"/><line x1="40" y1="100" x2="460" y2="100"/></g>${chartBars}</svg>\n  </g>`,
      `  <g id="${id("table")}" data-slidra-name="Table" data-slidra-type="table" data-slidra-cols="${colW.join(" ")}" data-slidra-rows="${tableRows.map(() => rowH).join(" ")}" data-slidra-header="1" data-slidra-theme="dark" transform="translate(700 230)">\n    ${cells}\n  </g>`,
      footer(),
    ].join("\n"),
  }));

  // 6 · Media
  const hasMedia = mediaDir && existsSync(path.join(mediaDir, "intro.webm"));
  if (hasMedia) {
    slides.push(slide({
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
    }));
  }

  // 7 · Closing
  slides.push(slide({
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
  }));

  const entries = [];
  const slidePaths = slides.map((_, i) => `slides/${String(i + 1).padStart(3, "0")}.svg`);
  entries.push(["slides", null], ["assets", null], ["fonts", null]);
  const extra = {};
  if (fontPath) {
    entries.push(["fonts/NotoSansTC-Presentation.ttf", readFileSync(fontPath)]);
    const licence = path.join(path.dirname(fontPath), "LICENSE-NotoSansTC.txt");
    if (existsSync(licence)) entries.push(["fonts/LICENSE-NotoSansTC.txt", readFileSync(licence)]);
    extra.fonts = [{
      file: "fonts/NotoSansTC-Presentation.ttf",
      family: "Noto Sans TC",
      license: "SIL Open Font License 1.1",
      licenseFile: "fonts/LICENSE-NotoSansTC.txt",
      source: "https://fonts.google.com/noto/specimen/Noto+Sans+TC",
    }];
  }
  if (hasMedia) {
    entries.push(["assets/intro.webm", readFileSync(path.join(mediaDir, "intro.webm"))]);
    entries.push(["assets/narration.oga", readFileSync(path.join(mediaDir, "narration.oga"))]);
  }
  entries.push(["assets/badge.svg", `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 384 170"><rect width="384" height="170" rx="12" fill="#c8233b"/><text x="192" y="100" font-size="34" font-family="system-ui, sans-serif" font-weight="700" fill="#fff" text-anchor="middle">assets/badge.svg</text></svg>`]);
  slides.forEach((markup, i) => entries.push([slidePaths[i], markup]));
  entries.push(["project.json", project("Slidra Showcase", slidePaths, extra)]);
  return { entries, text: slides.join("\n") };
}

// ─── Minimal and legacy decks ──────────────────────────────────────────

function minimal() {
  const markup = slide({
    bg: "#fbf9f8",
    body: `  <g id="el-hello0000000" data-slidra-name="Hello">\n    <text x="640" y="380" font-size="96" text-anchor="middle" fill="#1f1a1a" font-weight="700">Hello, .slidra</text>\n  </g>`,
  });
  return [["slides", null], ["assets", null], ["fonts", null], ["slides/001.svg", markup], ["project.json", project("Minimal", ["slides/001.svg"])]];
}

function legacy() {
  const one = slide({
    effects: [effect("el-legacy00000", "enter", "fly-up", "on-click")],
    body: [
      text("el-legacyhead0", "Heading", 640, 300, 72, INK, "A legacy ZIP deck", ' text-anchor="middle" font-weight="700"'),
      text("el-legacy00000", "Body", 640, 400, 32, MUTED, "formatVersion 4 · read-only in the viewer", ' text-anchor="middle"'),
    ].join("\n"),
  });
  const json = JSON.stringify({ formatVersion: 4, name: "Legacy ZIP (v4)", canvas: { width: 1280, height: 720 }, slides: ["slides/001.svg"] }, null, 2) + "\n";
  return [["project.json", json], ["slides", null], ["slides/001.svg", one], ["assets", null], ["fonts", null]];
}

const deck = showcase();
writeSqliteDeck(path.join(OUT, "showcase.slidra"), deck.entries);
writeSqliteDeck(path.join(OUT, "minimal.slidra"), minimal());
writeZipDeck(path.join(OUT, "legacy-zip-v4.slidra"), legacy());
writeFileSync(path.join(ROOT, "tools", ".showcase-text.txt"), deck.text);
console.log("wrote examples/showcase.slidra, examples/minimal.slidra, examples/legacy-zip-v4.slidra");
