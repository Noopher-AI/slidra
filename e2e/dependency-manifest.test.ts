import { createRequire } from "node:module";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Guards against declaration drift: `node_modules` on disk silently
 * outliving a removed `package.json` entry. Without this, `npm run test:e2e`
 * stays green after a dependency is dropped from `package.json` as long as
 * nobody reinstalls.
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const require = createRequire(path.join(rootDir, "package.json"));

const BARE_IMPORT_PATTERN =
  /(?:^|\n)\s*(?:import|export)\s[^;]*?\bfrom\s+["']([^"']+)["']|(?:^|\n)\s*import\s+["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g;

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      // e2e/fixtures/ holds deliberately broken imports for
      // loader-failure-guard.test.ts — not real dependency usage.
      if (entry === "fixtures") continue;
      out.push(...listTsFiles(full));
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

function extractBareSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(BARE_IMPORT_PATTERN)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (!specifier) continue;
    if (specifier.startsWith(".") || specifier.startsWith("/")) continue;
    if (specifier.startsWith("node:")) continue;
    // Workspace packages: resolved by e2e/vitest.config.ts's `resolve.alias`
    // straight to TypeScript source, never through node_modules.
    if (specifier.startsWith("@slidra/")) continue;
    specifiers.push(specifier);
  }
  return specifiers;
}

function packageNameOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
}

describe("e2e dependency declaration guard", () => {
  it("every bare module import in e2e source is declared in package.json and installed", () => {
    const pkg = JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf-8"));
    const declared = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ]);

    const files = listTsFiles(path.join(rootDir, "e2e"));
    expect(files.length).toBeGreaterThan(0);

    const usedPackages = new Map<string, string>(); // package name -> first file that imports it
    for (const file of files) {
      const source = readFileSync(file, "utf-8");
      for (const specifier of extractBareSpecifiers(source)) {
        const name = packageNameOf(specifier);
        if (!usedPackages.has(name)) usedPackages.set(name, path.relative(rootDir, file));
      }
    }
    expect(usedPackages.size).toBeGreaterThan(0);

    const failures: string[] = [];
    for (const [name, fromFile] of usedPackages) {
      if (!declared.has(name)) {
        failures.push(`"${name}"（來自 ${fromFile}）未宣告於 package.json 的 dependencies/devDependencies`);
        continue;
      }
      try {
        require.resolve(name);
      } catch {
        failures.push(`"${name}"（來自 ${fromFile}）已宣告但在 node_modules 中解析不到，請重新 npm install`);
      }
    }

    expect(failures).toEqual([]);
  });
});
