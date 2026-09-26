// ESLint flat config: the recommended rules over the viewer (browser), the
// Next.js route handlers and tools (Node), the tests, and the slide runtime
// (a plain ES5-style script that runs inside the sandboxed slide frame).

import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: [".next/**", "node_modules/**", "next-env.d.ts"] },
  js.configs.recommended,
  {
    files: ["**/*.{js,mjs,jsx}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrors: "none" }],
      eqeqeq: ["error", "always"],
      "no-var": "error",
      "prefer-const": "error",
    },
  },
  {
    // Without a React plugin ESLint cannot see a component used only in JSX.
    files: ["**/*.jsx"],
    rules: { "no-unused-vars": ["error", { varsIgnorePattern: "^[A-Z]", argsIgnorePattern: "^_", caughtErrors: "none" }] },
  },
  {
    // Runs as a classic script inside every slide frame; kept to ES5 syntax on purpose.
    files: ["public/js/player-runtime.js"],
    languageOptions: { sourceType: "script", globals: globals.browser },
    rules: { "no-var": "off", "prefer-const": "off" },
  },
];
