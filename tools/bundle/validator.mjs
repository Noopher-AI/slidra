#!/usr/bin/env node
// The entry of the self-contained validator (validator/slidra-validate.mjs in
// the bundle tools/build-bundle.mjs builds). Imported, it exports
// validateDeck and runValidateCli; run as a program, it is slidra-validate.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runValidateCli } from "../../lib/validate-cli.js";

export { validateDeck } from "../../lib/validate.js";
export { runValidateCli };

const isMain = () => {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (isMain()) process.exitCode = await runValidateCli(process.argv.slice(2));
