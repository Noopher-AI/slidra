#!/usr/bin/env node
// NOOP-278: after `cargo build --release`, point `node_modules/.bin/co-motion`
// at the Rust binary instead of the npm-workspaces-generated symlink to
// `packages/cli/bin/co-motion.js`.
//
// `node_modules/.bin/co-motion` is rebuilt by npm itself (from
// `packages/cli/package.json`'s `bin` field) on every `npm install`/`npm
// ci`, so this has to re-run at the END of every build, and has to `rm`
// the existing entry first — renaming over it isn't enough because npm's
// version is itself a symlink, not a plain file.
//
// This script does NOT touch `packages/cli/package.json`'s `bin` field —
// that field is npm workspaces' own source of truth for what a fresh
// `npm install` wires up by default, and changing it would make the
// post-install state (before this script has run) unpredictable.

import { existsSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(repoRoot, "target", "release", "co-motion");
const linkPath = join(repoRoot, "node_modules", ".bin", "co-motion");

if (!existsSync(target)) {
  // A missing target here means `cargo build --release` didn't actually
  // produce a binary — failing loudly is the point: a silent skip would
  // leave `node_modules/.bin/co-motion` pointing at whatever it already
  // was (npm's Node symlink, or a stale prior Rust build), so tests and
  // e2e fixtures would keep passing against the wrong engine without any
  // indication that the build itself is broken.
  console.error(`link-cli: cargo build output missing at ${target}`);
  process.exit(1);
}

rmSync(linkPath, { force: true });
symlinkSync(target, linkPath);
