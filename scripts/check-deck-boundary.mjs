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
  for (const statement of ast.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier.getText(ast).slice(1, -1);
    if (specifier !== "node:fs" && specifier !== "node:fs/promises") continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const binding of bindings.elements) {
      const imported = binding.propertyName?.text ?? binding.name.text;
      if (/^(readFile|readFileSync|writeFile|writeFileSync|appendFile|appendFileSync|copyFile|copyFileSync|createReadStream|createWriteStream)$/.test(imported)) {
        fsFunctions.add(binding.name.text);
      }
    }
  }
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && fsFunctions.has(node.expression.text)) {
      const argument = node.arguments[0]?.getText(ast) ?? "";
      if (/\.slidra\b/i.test(argument)) {
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
