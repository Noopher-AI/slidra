// The esbuild options for the <slidra-player> web component, shared by
// tools/build-element.mjs (the npm package) and tools/build-bundle.mjs (the
// vendoring bundle): one ES module with the slide runtime inlined.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The slide runtime's source, exactly as served at /js/player-runtime.js. */
export const readRuntime = () => readFileSync(path.join(ROOT, "public/js/player-runtime.js"), "utf8");

/**
 * @param {{ outfile: string, sourcemap?: boolean }} options
 * @returns {import("esbuild").BuildOptions}
 */
export function elementBuildOptions({ outfile, sourcemap = true }) {
  return {
    absWorkingDir: ROOT,
    entryPoints: ["lib/element/index.js"],
    outfile,
    bundle: true,
    format: "esm",
    target: "es2022",
    minify: true,
    sourcemap,
    legalComments: "none",
    define: { __SLIDRA_RUNTIME__: JSON.stringify(readRuntime()) },
    banner: { js: "/* <slidra-player> — plays .slidra decks. MIT licence. https://github.com/Noopher-AI/slidra */" },
    logLevel: "info",
  };
}
