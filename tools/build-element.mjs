// Builds the <slidra-player> web component into one ES module,
// packages/slidra-player/dist/slidra-player.js, with the slide runtime
// inlined so it needs nothing else at run time.
//
//   node tools/build-element.mjs [--watch]

import path from "node:path";
import * as esbuild from "esbuild";
import { ROOT, elementBuildOptions } from "./element-options.mjs";

const options = elementBuildOptions({ outfile: path.join(ROOT, "packages/slidra-player/dist/slidra-player.js") });

if (process.argv.includes("--watch")) await (await esbuild.context(options)).watch();
else await esbuild.build(options);
