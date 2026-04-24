import tsParser from "@typescript-eslint/parser";

export default [
  {
    ignores: ["dist/**", "out/**", "node_modules/**"],
  },
  {
    files: ["src/renderer/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: "latest",
      sourceType: "module",
    },
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "node-pty",
              message: "Renderer must not import node-pty. Use preload/main IPC instead.",
            },
          ],
          patterns: ["node-pty/*"],
        },
      ],
    },
  },
];
