#!/usr/bin/env node
const argv = process.argv.slice(2);

if (argv[0] === "serve") {
  // `serve` starts a long-running HTTP process instead of dispatching one
  // command, so it does not go through main()/parseArgv like the other
  // subcommands. @co-motion/server depends on @co-motion/cli for the
  // command registry (ADR-0002: serve must dispatch through the exact same
  // registry the one-shot CLI uses), so this package's own compiled
  // TypeScript must never import @co-motion/server back — that would make
  // the project-reference graph circular. This plain-JS shim (outside the
  // tsc -b build) is where the runtime-only edge lives instead.
  const { runServeCli } = await import("@co-motion/server");
  process.exitCode = await runServeCli(argv.slice(1));
} else {
  const { main } = await import("../dist/bin.js");
  main(argv)
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
