// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

const root = path.resolve(process.argv[2] ?? process.cwd());
const offenders = [];

async function filesBelow(dir, extension) {
  const found = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return found;
    throw error;
  }
  for (const entry of entries) {
    if (["node_modules", "dist", "target", ".next"].includes(entry.name)) continue;
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await filesBelow(target, extension)));
    else if (target.endsWith(extension)) found.push(target);
  }
  return found;
}

for (const file of await filesBelow(path.join(root, "packages"), ".ts")) {
  if (!file.includes(`${path.sep}src${path.sep}`)) continue;
  const source = await readFile(file, "utf8");
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const fsFunctions = new Set();
  const fsNamespaces = new Set();
  const deckPaths = new Set();
  const isFsModule = (node) => {
    if (!node || !ts.isStringLiteralLike(node)) return false;
    return node.text === "node:fs" || node.text === "node:fs/promises";
  };
  const isRequire = (node) =>
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "require" &&
    isFsModule(node.arguments[0]);
  const expressionHasDeckPath = (node) => {
    if (ts.isIdentifier(node) && deckPaths.has(node.text)) return true;
    if ((ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) && /\.slidra\b/i.test(node.text)) return true;
    let found = false;
    ts.forEachChild(node, (child) => {
      if (!found && expressionHasDeckPath(child)) found = true;
    });
    return found;
  };
  const registerBinding = (name, initializer) => {
    if (!initializer) return false;
    let changed = false;
    const add = (set, value) => {
      if (!set.has(value)) {
        set.add(value);
        changed = true;
      }
    };
    if (ts.isIdentifier(name)) {
      if (isRequire(initializer) || (ts.isIdentifier(initializer) && fsNamespaces.has(initializer.text))) add(fsNamespaces, name.text);
      if (
        (ts.isIdentifier(initializer) && fsFunctions.has(initializer.text)) ||
        (ts.isPropertyAccessExpression(initializer) && ts.isIdentifier(initializer.expression) && fsNamespaces.has(initializer.expression.text))
      ) add(fsFunctions, name.text);
      if (expressionHasDeckPath(initializer)) add(deckPaths, name.text);
    } else if (ts.isObjectBindingPattern(name) && (isRequire(initializer) || (ts.isIdentifier(initializer) && fsNamespaces.has(initializer.text)))) {
      for (const element of name.elements) add(fsFunctions, element.name.text);
    }
    return changed;
  };
  for (const statement of ast.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!isFsModule(statement.moduleSpecifier)) continue;
    if (statement.importClause?.name) fsNamespaces.add(statement.importClause.name.text);
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) fsNamespaces.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const binding of bindings.elements) fsFunctions.add(binding.name.text);
    }
  }
  // Resolve aliases and path variables to a fixed point so declaration order
  // cannot create a hole in the build-time boundary.
  let changed = true;
  while (changed) {
    changed = false;
    const collect = (node) => {
      if (ts.isVariableDeclaration(node)) changed = registerBinding(node.name, node.initializer) || changed;
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        changed = registerBinding(node.left, node.right) || changed;
      }
      ts.forEachChild(node, collect);
    };
    collect(ast);
  }
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const directFunction = ts.isIdentifier(node.expression) && fsFunctions.has(node.expression.text);
      const namespaceMember =
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        fsNamespaces.has(node.expression.expression.text);
      if ((directFunction || namespaceMember) && node.arguments.some(expressionHasDeckPath)) {
        const { line } = ast.getLineAndCharacterOfPosition(node.getStart(ast));
        offenders.push(`${path.relative(root, file)}:${line + 1}: direct .slidra filesystem I/O`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
}

const rustBanned = ["workspace::registry", "workspace::lock", "projects.json", ".projects.json.lock", "clipboard_file_path"];
for (const file of await filesBelow(path.join(root, "crates", "slidra", "src"), ".rs")) {
  let source = await readFile(file, "utf8");
  source = source.split(/^#\[cfg\([^\n]*\btest\b[^\n]*\)\]/m, 1)[0];
  source = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  for (const banned of rustBanned) {
    if (source.includes(banned)) offenders.push(`${path.relative(root, file)}: forbidden legacy state symbol ${banned}`);
  }
}

if (offenders.length > 0) {
  console.error("Deck boundary violations:\n" + offenders.map((item) => `- ${item}`).join("\n"));
  process.exit(1);
}
console.log("Deck boundary check passed");
