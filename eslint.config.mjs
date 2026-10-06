import js from "@eslint/js";
import globals from "globals";


export default [
  {
    // Subprojects carry their own eslint configs and their own dependency
    // trees. ESLint discovers `payment-dashboard/eslint.config.js` when
    // walking the tree, then fails to resolve that config's plugins (they are
    // declared in `payment-dashboard/package.json`, not the root), aborting the
    // whole root run with ERR_MODULE_NOT_FOUND. They are linted separately
    // via `npm --prefix payment-dashboard run lint`, so exclude them here.
    ignores: ["payment-dashboard/**", "packages/**"],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.node
      }
    },
    rules: {
      "no-unused-vars": "warn",
      "no-undef": "error"
    }
  },
  {
    files: ["**/*.test.js"],
    languageOptions: {
      globals: {
        ...globals.jest
      }
    }
  }
];