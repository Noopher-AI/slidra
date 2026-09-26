// Builds the <slidra-player> web component into one ES module,
// packages/slidra-player/dist/slidra-player.js, with the slide runtime
// inlined so it needs nothing else at run time.
//
//   node tools/build-element.mjs [--watch]

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtime = readFileSync(path.join(ROOT, "public/js/player-runtime.js"), "utf8");

/** @type {import("esbuild").BuildOptions} */
const options = {
  entryPoints: [path.join(ROOT, "lib/element/index.js")],
  outfile: path.join(ROOT, "packages/slidra-player/dist/slidra-player.js"),
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: true,
  sourcemap: true,
  legalComments: "none",
  define: { __SLIDRA_RUNTIME__: JSON.stringify(runtime) },
  banner: { js: "/* <slidra-player> — plays .slidra decks. MIT licence. https://github.com/Noopher-AI/slidra */" },
  logLevel: "info",
};

if (process.argv.includes("--watch")) await (await esbuild.context(options)).watch();
else await esbuild.build(options);
