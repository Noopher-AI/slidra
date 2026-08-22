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
  // A downstream pipe closing early (e.g. `co-motion cat <id> <path> | head`)
  // makes a later process.stdout.write() fail with EPIPE. Node streams throw
  // an unhandled exception for an 'error' event with no listener, which would
  // crash the process for what is normal pipeline behaviour, not a real
  // failure.
  //
  // This is installed only on the one-shot branch, deliberately. Exiting the
  // whole process on EPIPE is right for a command that has finished writing
  // its output and has nothing left to clean up; it is wrong for the resident
  // `serve` process, which would skip its own shutdown and report success
  // while doing it. Nothing in the package's public API (src/index.ts)
  // reaches this file either, so importing @co-motion/cli as a library never
  // installs this listener.
  process.stdout.on("error", (error) => {
    if (error.code === "EPIPE") {
      process.exit(0);
    }
    throw error;
  });

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
