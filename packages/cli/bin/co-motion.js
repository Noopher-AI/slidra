#!/usr/bin/env node
import { main } from "../dist/bin.js";

// A downstream pipe closing early (e.g. `co-motion cat <id> <path> | head`)
// makes a later process.stdout.write() fail with EPIPE. Node streams throw
// an unhandled exception for an 'error' event with no listener, which would
// crash the process for what is normal pipeline behaviour, not a real
// failure. This lives only in the executable entry point — nothing in the
// package's public API (src/index.ts) reaches this file, so importing
// @co-motion/cli as a library never installs this listener.
process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") {
    process.exit(0);
  }
  throw error;
});

main(process.argv.slice(2))
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
