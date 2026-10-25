import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    environment: "node",
    setupFiles: ["src/test/setup.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.test.{ts,tsx}",
        "src/test/**",
        "src/dev/**",
        "src/**/*.d.ts",
        "src/**/types.ts",
        "src/main.tsx",
      ],
      thresholds: {
        lines: 80,
        branches: 70,
      },
    },
    css: {
      // The height regression imports only these two stylesheets as strings;
      // leave the rest of the suite on Vitest's lightweight CSS proxy.
      include: [
        /\/App\.css(?:\?|$)/,
        /\/home\.css(?:\?|$)/,
        /\/SettingsDialog\.module\.css(?:\?|$)/,
        /\/workbench\.css(?:\?|$)/,
        /\/shell\.css(?:\?|$)/,
      ],
    },
  },
});
