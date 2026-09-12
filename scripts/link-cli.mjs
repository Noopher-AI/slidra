#!/usr/bin/env node
// NOOP-278: after `cargo build --release`, point `node_modules/.bin/comotion`
// at the Rust binary. [E4.T12] deletes `packages/cli` — with it, the
// npm-workspaces-generated symlink this script used to race against (`npm
// install` recreating `node_modules/.bin/comotion` from
// `packages/cli/package.json`'s own `bin` field) is gone too, but this
// script still has to run at the END of every build: nothing else creates
// `node_modules/.bin/comotion` at all now that there is no `bin`-declaring
// workspace package for npm to wire up by default.

import { existsSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(repoRoot, "target", "release", "comotion");
const linkPath = join(repoRoot, "node_modules", ".bin", "comotion");

if (!existsSync(target)) {
  // A missing target here means `cargo build --release` didn't actually
  // produce a binary — failing loudly is the point: a silent skip would
  // leave `node_modules/.bin/comotion` pointing at whatever it already
  // was (npm's Node symlink, or a stale prior Rust build), so tests and
  // e2e fixtures would keep passing against the wrong engine without any
  // indication that the build itself is broken.
  console.error(`link-cli: cargo build output missing at ${target}`);
  process.exit(1);
}

rmSync(linkPath, { force: true });
symlinkSync(target, linkPath);
