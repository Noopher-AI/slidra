#!/usr/bin/env node
// NOOP-278: generates golden fixtures for `crates/co-motion/tests/golden/`
// by running the REAL TypeScript implementation (`packages/core`'s built
// `dist/`) — never by hand-computing expected values, and never by
// capturing the Rust port's own output. A fixture whose expected value came
// from anywhere other than the TS source it's meant to check would pass no
// matter what the Rust port did wrong, so this script imports
// `packages/core/dist` directly rather than reimplementing any of its
// logic.
//
// Requires `packages/core` to already be built (`npm run build --workspace=packages/core`)
// — this script does not build it, so a stale `dist/` produces a stale
// fixture; run the build first if `packages/core/src` changed since the
// last fixture generation.
//
// Usage: node scripts/gen-golden.mjs

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(repoRoot, "crates", "co-motion", "tests", "golden");
mkdirSync(outDir, { recursive: true });

function writeJson(name, data) {
  const path = join(outDir, name);
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
  console.log(`wrote ${path}`);
}

// --- svgnum.json ------------------------------------------------------------
//
// >= 200 values per plan AC9, spanning the ranges this project's real
// coordinates/widths occupy (roughly 1e-4 .. 1e5) plus a few boundary/edge
// values explicitly called out in the plan (0, -0, a rounding-boundary
// value, 1/3, a large value near the JS exponential-notation threshold).
// NaN/Infinity are deliberately excluded — `format_svg_number` treats those
// as a caller bug (panic), not a value with a defined golden output.
async function genSvgNumber() {
  const { formatSvgNumber } = await import(join(repoRoot, "packages/core/dist/svg-number.js"));

  const values = [];
  values.push(0, -0, 1, -1, 300, -300, 27.84, 62.592, 97.344, 104.256);
  values.push(1 / 3, -1 / 3, 2 / 3);
  values.push(0.00005, 0.000049999, 0.30005, 1.00005);
  values.push(123456789.123456, -123456789.123456);
  values.push(0.0001, 0.00001, 100000, 99999.9999);
  // NOTE: 1e21 is deliberately NOT included here. `toFixed`'s spec bypasses
  // fixed-point formatting entirely for |x| >= 1e21 (returns a plain
  // `ToString(x)`, i.e. `"1e+21"`), which Rust's f64 `Display` never
  // produces (it has no exponential-notation output at all) — this is the
  // `KNOWN GAP` documented in svgnum.rs's module comment, deliberately
  // out of scope per the plan (unreachable for this project's real
  // coordinate/dimension values). Including it here would make this a
  // permanently-red golden case for a divergence everyone already agreed
  // not to fix. 1e-7 IS included: toFixed(4) rounds it to 0 either way, so
  // both engines agree ("0"), it's not actually a gap.
  values.push(1e-7);

  // Deterministic pseudo-random spread across the realistic coordinate
  // range (project canvases are ~1280x720 px; widths/heights/offsets stay
  // well under 1e5). A fixed seed keeps this fixture reproducible across
  // regenerations rather than churning on every run for no reason.
  let state = 0x2545f4914f6cdd1dn;
  function nextRandom() {
    state ^= state << 13n;
    state &= 0xffffffffffffffffn;
    state ^= state >> 7n;
    state ^= state << 17n;
    state &= 0xffffffffffffffffn;
    return Number(state % 1000000n) / 1000000;
  }
  for (let i = 0; i < 200; i++) {
    const magnitude = [0.01, 1, 10, 100, 1000, 10000][i % 6];
    const sign = i % 7 === 0 ? -1 : 1;
    values.push(sign * nextRandom() * magnitude);
  }

  const cases = values.map((input) => ({ input, expected: formatSvgNumber(input) }));
  writeJson("svgnum.json", cases);
}

// --- text_wrap_fixture.json --------------------------------------------------
//
// The exact scenario from the implementation plan (NOOP-277, section 5/AC9):
// `co-motion textbox add <id> slides/001.svg --x 100 --y 100 --width 300
// --font-size 24` with a two-paragraph CJK+ASCII mixed string, run through
// the real CLI end-to-end (not just wrapText/renderTextBoxContent in
// isolation) so the fixture is exactly what a human ran and inspected, not
// a reconstruction. This fixture is a regression pin, independently
// verified once already (2026-09-08, this ticket's Run 1) against a live
// `node packages/cli/bin/co-motion.js textbox add ...` invocation.
async function genTextWrapFixture() {
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");

  const home = mkdtempSync(join(tmpdir(), "co-motion-golden-home-"));
  const workspace = mkdtempSync(join(tmpdir(), "co-motion-golden-ws-"));
  const cliBin = join(repoRoot, "packages/cli/bin/co-motion.js");
  const env = { ...process.env, CO_MOTION_HOME: home };

  const comotPath = join(workspace, "t.comot");
  execFileSync("node", [cliBin, "new", comotPath, "--name", "測試"], { env });
  const openOutput = execFileSync("node", [cliBin, "open", comotPath], { env }).toString();
  const id = JSON.parse(openOutput.split("\n").slice(1).join("\n")).id;

  const text = "中文字排版測試與 ASCII mixed content wrapping\n第二段落";
  execFileSync(
    "node",
    [cliBin, "textbox", "add", id, "slides/001.svg", "--x", "100", "--y", "100", "--width", "300", "--font-size", "24", "--text", text],
    { env },
  );

  const svg = execFileSync("node", [cliBin, "cat", id, "slides/001.svg"], { env }).toString();
  const textElementMatch = svg.match(/<text font-family="Noto Sans TC" font-size="24"[^>]*>(.*?)<\/text>/s);
  const heightMatch = svg.match(/data-comot-text-height="([^"]+)"/);
  if (!textElementMatch || !heightMatch) {
    throw new Error(`gen-golden: could not extract fixture from generated SVG:\n${svg}`);
  }

  writeJson("text_wrap_fixture.json", {
    input: {
      text,
      width: 300,
      fontSizePx: 24,
      fontFamily: "Noto Sans TC",
    },
    expectedInnerMarkup: textElementMatch[1],
    expectedTextHeight: heightMatch[1],
  });
}

await genSvgNumber();
await genTextWrapFixture();
