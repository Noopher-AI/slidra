import { test } from "node:test";
import assert from "node:assert/strict";
import { ESLint } from "eslint";

const eslint = new ESLint({ cwd: new URL("..", import.meta.url).pathname });

async function ruleIds(code, filePath) {
  const [result] = await eslint.lintText(code, { filePath });
  return result.messages.map((message) => message.ruleId);
}

test("the viewer is linted as browser ES modules", async () => {
  const ids = await ruleIds("export const f = (a) => { if (a == 1) return undefinedName; var x = 1; return x; };\n", "lib/viewer/example.js");
  assert.ok(ids.includes("eqeqeq"));
  assert.ok(ids.includes("no-undef"));
  assert.ok(ids.includes("no-var"));
  assert.deepEqual(await ruleIds("export const size = () => window.innerWidth + document.body.clientWidth;\n", "lib/viewer/example.js"), []);
});

test("the slide runtime is linted as a classic ES5-style script", async () => {
  assert.deepEqual(await ruleIds('(function () {\n  "use strict";\n  var plan = window.__SLIDRA_PLAN__ || {};\n  parent.postMessage(plan, "*");\n})();\n', "public/js/player-runtime.js"), []);
});

test("components used only in JSX are not reported as unused", async () => {
  assert.deepEqual(await ruleIds('import Shell from "./shell.jsx";\nexport default function Page() {\n  return <Shell />;\n}\n', "app/example.jsx"), []);
});
