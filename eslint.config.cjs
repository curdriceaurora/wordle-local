const js = require("@eslint/js");
const globals = require("globals");

module.exports = [
  {
    ignores: [
      "coverage/**",
      "node_modules/**",
      "playwright-report/**",
      "public/dist/**",
      "test-results/**"
    ]
  },
  js.configs.recommended,
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "script",
      globals: {
        ...globals.node
      }
    },
    rules: {
      eqeqeq: ["error", "always"],
      "no-implicit-coercion": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      "no-prototype-builtins": "error",
      "no-self-compare": "error",
      "no-unneeded-ternary": "error",
      "no-unreachable-loop": "error",
      "no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }
      ],
      "no-useless-assignment": "off",
      "preserve-caught-error": "off",
      yoda: ["error", "never"]
    }
  },
  {
    files: ["public/**/*.js"],
    languageOptions: {
      globals: {
        ...globals.browser
      }
    }
  },
  {
    files: ["tests/**/*.test.js"],
    languageOptions: {
      globals: {
        ...globals.jest,
        ...globals.node
      }
    }
  },
  {
    files: ["tests/ui/**/*.js"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node
      }
    }
  }
];
