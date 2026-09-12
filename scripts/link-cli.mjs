#!/usr/bin/env node
// After `cargo build --release`, point `node_modules/.bin/slidra`
// at the Rust binary. There is no `bin`-declaring workspace package for npm
// to wire up by default, so this script still has to run at the END of
// every build: nothing else creates `node_modules/.bin/slidra` at all.

import { existsSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(repoRoot, "target", "release", "slidra");
const linkPath = join(repoRoot, "node_modules", ".bin", "slidra");

if (!existsSync(target)) {
  // A missing target here means `cargo build --release` didn't actually
  // produce a binary — failing loudly is the point: a silent skip would
  // leave `node_modules/.bin/slidra` pointing at whatever it already
  // was (npm's Node symlink, or a stale prior Rust build), so tests and
  // e2e fixtures would keep passing against the wrong engine without any
  // indication that the build itself is broken.
  console.error(`link-cli: cargo build output missing at ${target}`);
  process.exit(1);
}

rmSync(linkPath, { force: true });
symlinkSync(target, linkPath);
