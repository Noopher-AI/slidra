// Builds dist/slidra-bundle/: everything another project needs to vendor
// this repository's format and player at one tag, deterministically (the
// same sources give byte-identical files: no timestamps, no absolute paths,
// sorted listings, esbuild with fixed options).
//
//   node tools/build-bundle.mjs [outDir]
//
// player/     slidra-viewer.js (the viewer library, lib/viewer/index.js),
//             slidra-player.js (the web component), player-runtime.js (the
//             slide runtime), slidra-viewer.css and the viewer's and
//             presenter view's markup (viewer-shell.html, presenter-shell.html)
// validator/  slidra-validate.mjs (validateDeck and the CLI, dependencies
//             included) and the licences of what it bundles
// schema/, spec/, conformance/, LICENSE
// MANIFEST.json  formatVersion, source commit, sha256 and size of every other file
//
// SLIDRA_SOURCE_COMMIT overrides the commit recorded in MANIFEST.json (for
// a build outside a git checkout).

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";
import { ROOT, elementBuildOptions, readRuntime } from "./element-options.mjs";
import { FORMAT_VERSION } from "../lib/viewer/deck.js";

export const DEFAULT_OUT_DIR = path.join(ROOT, "dist/slidra-bundle");

const BANNER = "/* Slidra — the open .slidra presentation format. MIT licence. https://github.com/Noopher-AI/slidra */";

/** Files are written with "\n" line ends as they are in git; paths in the bundle always use "/". */
const posix = (p) => p.split(path.sep).join("/");

/** Every file under `dir` (relative, "/"-separated, sorted by code unit). */
function listFiles(dir) {
  const out = [];
  const walk = (rel) => {
    for (const entry of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) out.push(child);
    }
  };
  walk("");
  return out.sort(compare);
}

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** @param {Partial<import("esbuild").BuildOptions>} options */
async function bundleText(options) {
  const result = await esbuild.build({ absWorkingDir: ROOT, bundle: true, format: "esm", write: false, metafile: true, logLevel: "silent", charset: "utf8", ...options });
  const [file] = result.outputFiles;
  return { text: file.text, inputs: Object.keys(result.metafile.inputs) };
}

/** The licence texts of the npm packages a bundle includes, one after another, sorted by package name. */
function thirdPartyLicences(inputs) {
  const packages = new Set();
  for (const input of inputs) {
    const match = /^node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input);
    if (match) packages.add(match[1]);
  }
  const sections = [...packages].sort(compare).map((name) => {
    const dir = path.join(ROOT, "node_modules", name);
    const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
    const licenceFile = readdirSync(dir)
      .filter((file) => /^licen[cs]e/i.test(file))
      .sort(compare)[0];
    if (!licenceFile) throw new Error(`${name} has no licence file to bundle`);
    return `${pkg.name}@${pkg.version} (${pkg.license})\n\n${readFileSync(path.join(dir, licenceFile), "utf8").trim()}\n`;
  });
  return `Third-party software bundled into slidra-validate.mjs\n\n${sections.join(`\n${"-".repeat(72)}\n\n`)}`;
}

/** Renders a client component's static markup, as React first renders it (before the viewer wires itself on). */
async function renderShell(source, workDir) {
  const { code } = await esbuild.transform(readFileSync(path.join(ROOT, source), "utf8"), { loader: "jsx", jsx: "automatic", format: "esm" });
  const file = path.join(workDir, `${path.basename(source, ".jsx")}.mjs`);
  writeFileSync(file, code);
  const [{ default: Component }, { createElement }, { renderToStaticMarkup }] = await Promise.all([import(pathToFileURL(file).href), import("react"), import("react-dom/server")]);
  return `<!-- Generated from ${source} by tools/build-bundle.mjs. -->\n${renderToStaticMarkup(createElement(Component))}\n`;
}

function sourceCommit() {
  if (process.env.SLIDRA_SOURCE_COMMIT) return { commit: process.env.SLIDRA_SOURCE_COMMIT, dirty: null };
  try {
    const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return { commit: git("rev-parse", "HEAD"), dirty: git("status", "--porcelain", "--untracked-files=no") !== "" };
  } catch {
    return { commit: null, dirty: null };
  }
}

/**
 * Builds the bundle into `outDir` (emptied first).
 * @typedef {{ name: "slidra-bundle", formatVersion: number, source: { repository: string, commit: string | null, dirty: boolean | null }, files: { path: string, size: number, sha256: string }[] }} Manifest
 * @param {string} [outDir]
 * @returns {Promise<{ outDir: string, manifest: Manifest }>}
 */
export async function buildBundle(outDir = DEFAULT_OUT_DIR) {
  rmSync(outDir, { recursive: true, force: true });
  /** @type {Map<string, string | Buffer>} */
  const files = new Map();
  const copy = (from, to = from) => files.set(to, readFileSync(path.join(ROOT, from)));
  const runtime = readRuntime();

  // player/
  const viewer = await bundleText({ entryPoints: ["lib/viewer/index.js"], platform: "browser", target: "es2022", define: { __SLIDRA_RUNTIME__: JSON.stringify(runtime) }, banner: { js: BANNER } });
  files.set("player/slidra-viewer.js", viewer.text);
  const element = await bundleText({ ...elementBuildOptions({ outfile: "slidra-player.js", sourcemap: false }), write: false, logLevel: "silent" });
  files.set("player/slidra-player.js", element.text);
  files.set("player/player-runtime.js", runtime);
  copy("app/globals.css", "player/slidra-viewer.css");
  const workDir = path.join(ROOT, "node_modules/.cache/slidra-bundle");
  mkdirSync(workDir, { recursive: true });
  files.set("player/viewer-shell.html", await renderShell("app/viewer-shell.jsx", workDir));
  files.set("player/presenter-shell.html", await renderShell("app/presenter/presenter-shell.jsx", workDir));

  // validator/
  const schemas = Object.fromEntries(listFiles(path.join(ROOT, "spec/schema")).map((name) => [name, JSON.parse(readFileSync(path.join(ROOT, "spec/schema", name), "utf8"))]));
  const validator = await bundleText({
    entryPoints: ["tools/bundle/validator.mjs"],
    platform: "node",
    target: "node22",
    define: { __SLIDRA_SCHEMAS__: JSON.stringify(schemas) },
    banner: { js: BANNER },
  });
  files.set("validator/slidra-validate.mjs", validator.text);
  files.set("validator/THIRD-PARTY-LICENSES.txt", thirdPartyLicences(validator.inputs));

  // The format itself.
  for (const name of listFiles(path.join(ROOT, "spec/schema"))) copy(`spec/schema/${name}`, `schema/${name}`);
  for (const name of listFiles(path.join(ROOT, "spec")).filter((name) => name.endsWith(".md"))) copy(`spec/${name}`);
  copy("conformance/manifest.json");
  copy("conformance/README.md");
  for (const name of listFiles(path.join(ROOT, "conformance/decks"))) copy(`conformance/decks/${name}`);
  copy("LICENSE");

  const paths = [...files.keys()].sort(compare);
  const { commit, dirty } = sourceCommit();
  /** @type {Manifest} */
  const manifest = {
    name: "slidra-bundle",
    formatVersion: FORMAT_VERSION,
    source: { repository: "https://github.com/Noopher-AI/slidra", commit, dirty },
    files: paths.map((p) => {
      const bytes = Buffer.from(files.get(p));
      return { path: p, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    }),
  };
  for (const p of paths) {
    mkdirSync(path.join(outDir, path.dirname(p)), { recursive: true });
    writeFileSync(path.join(outDir, p), files.get(p));
  }
  writeFileSync(path.join(outDir, "MANIFEST.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { outDir, manifest };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const outDir = path.resolve(process.argv[2] ?? DEFAULT_OUT_DIR);
  const { manifest } = await buildBundle(outDir);
  const total = manifest.files.reduce((sum, file) => sum + file.size, 0);
  console.log(
    `${posix(path.relative(process.cwd(), outDir)) || "."}: ${manifest.files.length} files, ${total} bytes, formatVersion ${manifest.formatVersion}, commit ${manifest.source.commit ?? "unknown"}${manifest.source.dirty ? " (dirty)" : ""}`,
  );
}

export { listFiles };
