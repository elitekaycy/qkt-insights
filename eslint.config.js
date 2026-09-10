import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";

const TS_FILES = ["**/*.ts", "**/*.tsx"];

export default [
  // build output and vendored third-party bundles are not ours to lint
  { ignores: ["**/dist/**", "**/node_modules/**", "**/dev-dist/**", "apps/web/public/vendor/**"] },
  ...tsPlugin.configs["flat/recommended"].map((config) => ({ ...config, files: TS_FILES })),
  {
    files: TS_FILES,
    languageOptions: { parser: tsParser, ecmaVersion: 2022, sourceType: "module" },
    rules: {
      // The constitution bans `any` in exported signatures, which tsc and review
      // enforce; internal SQLite row casts and test fixtures use it deliberately.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
];
