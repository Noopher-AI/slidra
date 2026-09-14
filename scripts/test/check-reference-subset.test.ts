// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractReferenceCommands, extractSpecCommands, findViolations } from "../check-reference-subset.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("check-reference-subset", () => {
  // The real repo files, not a fixture — this is the one case that would
  // catch check-doc-commands.test.ts's own known gap (its equivalent test
  // never runs against anything but a temp-dir fixture, so a real
  // reference/spec drift would never fail `npm test`).
  it("finds zero violations between the real reference/commands.md and docs/spec/cli.md", () => {
    const referenceContent = readFileSync(
      path.join(ROOT, "packages/server/agent-workdir/reference/commands.md"),
      "utf-8",
    );
    const specContent = readFileSync(path.join(ROOT, "docs/spec/cli.md"), "utf-8");

    const referenceCommands = extractReferenceCommands(referenceContent);
    const specCommands = extractSpecCommands(specContent);
    const violations = findViolations(referenceCommands, specCommands);

    expect(violations).toEqual([]);
  });

  it("reports a reference command that has no entry in the spec", () => {
    const referenceContent = "## made up command\n\n**Parameters:** `<presentation-id>`.\n**Usage:** Does not exist.\n";
    const specContent = "# slidra CLI spec\n\n## `new`\n\n**Syntax**\n\n```\nslidra new <path>\n```\n";

    const referenceCommands = extractReferenceCommands(referenceContent);
    const specCommands = extractSpecCommands(specContent);
    const violations = findViolations(referenceCommands, specCommands);

    expect(violations).toEqual([
      { message: 'reference/commands.md: command "made up command" is not in docs/spec/cli.md' },
    ]);
  });

  it("reports a flag reference mentions that the spec's matching entry never mentions", () => {
    const referenceContent = "## asset import\n\n**Parameters:** `<presentation-id>` `<source>`, `--as csv` (optional).\n";
    const specContent =
      "# slidra CLI spec\n\n## `asset import`\n\n**Syntax**\n\n```\nslidra asset import <presentation-id> <source>\n```\n";

    const referenceCommands = extractReferenceCommands(referenceContent);
    const specCommands = extractSpecCommands(specContent);
    const violations = findViolations(referenceCommands, specCommands);

    expect(violations).toEqual([
      { message: 'reference/commands.md: command "asset import" flag --as is not in the matching entry in docs/spec/cli.md' },
    ]);
  });

  it("does not let a spec's --csv-asset token satisfy a reference requirement for bare --csv (no substring matching)", () => {
    const referenceContent = "## chart data set\n\n**Parameters:** `<presentation-id>`, `--csv <path>` (optional).\n";
    const specContent =
      "# slidra CLI spec\n\n## `chart data set`\n\n**Parameters**\n\n- `--csv-asset`: optional, virtual path inside the container.\n";

    const referenceCommands = extractReferenceCommands(referenceContent);
    const specCommands = extractSpecCommands(specContent);
    const violations = findViolations(referenceCommands, specCommands);

    expect(violations).toEqual([
      { message: 'reference/commands.md: command "chart data set" flag --csv is not in the matching entry in docs/spec/cli.md' },
    ]);
  });

  it("ignores a flag mentioned only in reference's Usage/Example prose, not in its Parameters line", () => {
    const referenceContent =
      "## cat\n\n**Parameters:** `<presentation-id>` `<path>`.\n**Usage:** Does not support `--recursive`; may be added in the future.\n";
    const specContent = "# slidra CLI spec\n\n## `cat`\n\n**Syntax**\n\n```\nslidra cat <presentation-id> <path>\n```\n";

    const referenceCommands = extractReferenceCommands(referenceContent);
    const specCommands = extractSpecCommands(specContent);
    const violations = findViolations(referenceCommands, specCommands);

    expect(violations).toEqual([]);
  });
});
