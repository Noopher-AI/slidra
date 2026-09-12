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
    const referenceContent = "## made up command\n\n**參數**：`<presentation-id>`。\n**用途**：不存在。\n";
    const specContent = "# comotion CLI 規格\n\n## `new`\n\n**語法**\n\n```\ncomotion new <path>\n```\n";

    const referenceCommands = extractReferenceCommands(referenceContent);
    const specCommands = extractSpecCommands(specContent);
    const violations = findViolations(referenceCommands, specCommands);

    expect(violations).toEqual([
      { message: "reference/commands.md: 命令「made up command」不在 docs/spec/cli.md" },
    ]);
  });

  it("reports a flag reference mentions that the spec's matching entry never mentions", () => {
    const referenceContent = "## asset import\n\n**參數**：`<presentation-id>` `<source>`、`--as csv`（選填）。\n";
    const specContent =
      "# comotion CLI 規格\n\n## `asset import`\n\n**語法**\n\n```\ncomotion asset import <presentation-id> <source>\n```\n";

    const referenceCommands = extractReferenceCommands(referenceContent);
    const specCommands = extractSpecCommands(specContent);
    const violations = findViolations(referenceCommands, specCommands);

    expect(violations).toEqual([
      { message: "reference/commands.md: 命令「asset import」的 --as 不在 docs/spec/cli.md 的對應條目" },
    ]);
  });

  it("does not let a spec's --csv-asset token satisfy a reference requirement for bare --csv (no substring matching)", () => {
    const referenceContent = "## chart data set\n\n**參數**：`<presentation-id>`、`--csv <path>`（選填）。\n";
    const specContent =
      "# comotion CLI 規格\n\n## `chart data set`\n\n**參數**\n\n- `--csv-asset`：選填，容器內虛擬路徑。\n";

    const referenceCommands = extractReferenceCommands(referenceContent);
    const specCommands = extractSpecCommands(specContent);
    const violations = findViolations(referenceCommands, specCommands);

    expect(violations).toEqual([
      { message: "reference/commands.md: 命令「chart data set」的 --csv 不在 docs/spec/cli.md 的對應條目" },
    ]);
  });

  it("ignores a flag mentioned only in reference's 用途/範例 prose, not in its 參數 line", () => {
    const referenceContent =
      "## cat\n\n**參數**：`<presentation-id>` `<path>`。\n**用途**：不支援 `--recursive`，未來可能加上。\n";
    const specContent = "# comotion CLI 規格\n\n## `cat`\n\n**語法**\n\n```\ncomotion cat <presentation-id> <path>\n```\n";

    const referenceCommands = extractReferenceCommands(referenceContent);
    const specCommands = extractSpecCommands(specContent);
    const violations = findViolations(referenceCommands, specCommands);

    expect(violations).toEqual([]);
  });
});
