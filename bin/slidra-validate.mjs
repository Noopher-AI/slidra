#!/usr/bin/env node
// slidra-validate: checks .slidra decks against the open format spec.
//
//   slidra-validate [--json] [--strict] [--quiet] <deck.slidra>...
//
// Exit status: 0 when every deck is valid (warnings allowed unless
// --strict), 1 when any deck has errors, 2 on a usage error.

import { readFileSync } from "node:fs";
import path from "node:path";
import { validateDeck } from "../lib/validate.js";

const USAGE = `Usage: slidra-validate [--json] [--strict] [--quiet] <deck.slidra>...

Checks .slidra decks against spec/slidra-format.md and spec/playback.md.

  --json    print one JSON report per deck (an array) instead of text
  --strict  treat warnings as errors
  --quiet   print errors only
  --help    show this help`;

async function main(argv) {
  const flags = new Set(argv.filter((arg) => arg.startsWith("--")));
  const files = argv.filter((arg) => !arg.startsWith("--"));
  const unknown = [...flags].filter((flag) => !["--json", "--strict", "--quiet", "--help"].includes(flag));
  if (flags.has("--help")) {
    console.log(USAGE);
    return 0;
  }
  if (unknown.length > 0 || files.length === 0) {
    console.error(unknown.length > 0 ? `Unknown option ${unknown[0]}.\n` : "No deck given.\n");
    console.error(USAGE);
    return 2;
  }

  const reports = [];
  for (const file of files) {
    let bytes;
    try {
      bytes = new Uint8Array(readFileSync(file));
    } catch (error) {
      reports.push({
        file,
        valid: false,
        errors: [{ severity: "error", code: "file-unreadable", message: error.message, rule: "—" }],
        warnings: [],
        summary: { container: null, formatVersion: null, slides: 0 },
      });
      continue;
    }
    reports.push(await validateDeck(bytes, { fileName: path.basename(file) }));
  }
  for (const report of reports) report.file = files[reports.indexOf(report)];

  const strict = flags.has("--strict");
  const failed = reports.some((report) => report.errors.length > 0 || (strict && report.warnings.length > 0));
  if (flags.has("--json")) {
    console.log(JSON.stringify(reports, null, 2));
  } else {
    for (const report of reports) printReport(report, { quiet: flags.has("--quiet"), strict });
  }
  return failed ? 1 : 0;
}

function printReport(report, { quiet, strict }) {
  const ok = report.errors.length === 0 && !(strict && report.warnings.length > 0);
  const { summary } = report;
  const detail = summary.container ? ` (${summary.container}, formatVersion ${summary.formatVersion}, ${summary.slides} slide${summary.slides === 1 ? "" : "s"})` : "";
  const counts = `${report.errors.length} error${report.errors.length === 1 ? "" : "s"}, ${report.warnings.length} warning${report.warnings.length === 1 ? "" : "s"}`;
  console.log(`${ok ? "✓" : "✗"} ${report.file}${detail}: ${counts}`);
  const lines = quiet ? report.errors : [...report.errors, ...report.warnings];
  for (const issue of lines) {
    const where = [issue.path, issue.element].filter(Boolean).join(" ");
    console.log(`  ${issue.severity === "error" ? "error  " : "warning"} ${where ? `${where}: ` : ""}${issue.message} [${issue.code}, ${issue.rule}]`);
  }
}

process.exitCode = await main(process.argv.slice(2));
