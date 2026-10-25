import { registerHooks } from "node:module";

const TYPESCRIPT_WITH_JS_API = "typescript6";

const isTypeScriptSpecifier = (specifier) =>
  specifier === "typescript" || specifier.startsWith("typescript/");

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!isTypeScriptSpecifier(specifier)) return nextResolve(specifier, context);
    return nextResolve(specifier.replace("typescript", TYPESCRIPT_WITH_JS_API), context);
  },
});

const { default: tseslint } = await import("typescript-eslint");
const { default: reactHooks } = await import("eslint-plugin-react-hooks");

const MAX_PARAMS = 3;
const MAX_DEPTH = 3;
const MIN_IDENTIFIER_LENGTH = 2;
const ALLOWED_MAGIC_NUMBERS = [-1, 0, 1, 2];
const BOOLEAN_PREFIXES = ["is", "has", "can", "should"];
const LIBRARY_MANDATED_BOOLEAN_NAMES =
  "^(checked|disabled|hidden|open|readOnly|required|selected|multiple|autoFocus|defaultOpen|defaultChecked|modal|asChild|forceMount)$";

const booleanNaming = {
  types: ["boolean"],
  format: ["PascalCase"],
  prefix: BOOLEAN_PREFIXES,
  leadingUnderscore: "allow",
};

export default tseslint.config(
  { ignores: ["dist/**", "coverage/**", "src-tauri/**"] },
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
      "react-hooks": reactHooks,
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/ban-ts-comment": [
        "error",
        {
          "ts-ignore": "allow-with-description",
          "ts-expect-error": "allow-with-description",
          "ts-nocheck": "allow-with-description",
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "TSAsExpression[expression.type='TSAsExpression'][expression.typeAnnotation.type='TSUnknownKeyword']",
          message: "Narrow the value with a type guard instead of `as unknown as T`.",
        },
      ],
      "@typescript-eslint/max-params": ["error", { max: MAX_PARAMS }],
      "max-depth": ["error", MAX_DEPTH],
      "id-length": ["error", { min: MIN_IDENTIFIER_LENGTH, properties: "never" }],
      "@typescript-eslint/no-magic-numbers": [
        "error",
        {
          ignore: ALLOWED_MAGIC_NUMBERS,
          ignoreArrayIndexes: true,
          ignoreEnums: true,
          ignoreNumericLiteralTypes: true,
          ignoreReadonlyClassProperties: true,
          ignoreTypeIndexes: true,
        },
      ],
      "@typescript-eslint/naming-convention": [
        "error",
        { selector: ["variable", "parameter"], ...booleanNaming },
        { selector: ["variable", "parameter"], modifiers: ["destructured"], types: ["boolean"], format: null },
        {
          selector: ["typeProperty", "classProperty", "parameterProperty"],
          ...booleanNaming,
          filter: { regex: LIBRARY_MANDATED_BOOLEAN_NAMES, match: false },
        },
      ],
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
      "no-console": ["error", { allow: ["warn", "error"] }],
      "no-debugger": "error",
    },
  },
  {
    files: ["src/**/*.test.{ts,tsx}", "src/test/**"],
    rules: {
      "@typescript-eslint/no-magic-numbers": "off",
    },
  },
);
