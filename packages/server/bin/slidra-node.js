#!/usr/bin/env node
// The Rust `slidra` binary's only remaining Node entry point
// (`crates/slidra/src/node_entry.rs`) — `docs/spec/cli.md`'s section on the
// registry-free entry points: serve and export. Plain JS, deliberately outside
// `tsc -b`'s project-reference graph (same reason the deleted
// legacy Node CLI shim was): it is the runtime-only edge
// between "the compiled binary on `PATH`" and this package's own build
// output, not a source file any other TypeScript module imports.
const argv = process.argv.slice(2);

if (argv[0] === "serve") {
  const { runServeCli } = await import("../dist/index.js");
  process.exitCode = await runServeCli(argv.slice(1));
} else if (argv[0] === "export") {
  const { runExportCli } = await import("../dist/index.js");
  process.exitCode = await runExportCli(argv.slice(1));
} else {
  // Rust only execs this script for `serve`/`export` — reaching here means
  // someone ran it directly.
  console.error("this entry point only accepts serve and export; run other commands directly on the slidra binary");
  process.exitCode = 1;
}
