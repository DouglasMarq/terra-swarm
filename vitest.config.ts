import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    environment: "node",
    setupFiles: ["src/test/setup.ts"],
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
