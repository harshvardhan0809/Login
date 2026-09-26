import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["dist/**", "node_modules/**"] },
  js.configs.recommended,
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.browser },
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "no-console": ["warn", { allow: ["warn", "error"] }],
      eqeqeq: ["error", "smart"],
      "prefer-const": "error",
      "no-var": "error",
    },
  },
  {
    // Server-side: build tooling, maintenance scripts, and the serverless
    // functions in api/, which run on Vercel rather than in a browser.
    files: ["vite.config.js", "eslint.config.js", "scripts/**/*.mjs", "api/**/*.js"],
    languageOptions: { globals: { ...globals.node } },
  },
];
