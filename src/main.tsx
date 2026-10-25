import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/geist";
import "@fontsource-variable/jetbrains-mono";
import "@fontsource-variable/jetbrains-mono/wght-italic.css";
import "./styles/index.css";
import { SystemRoot } from "./components/integration/SystemRoot";
import { useLocaleStore } from "./i18n";
import { BUNDLED_TERMINAL_FONT } from "./lib/terminalFonts";

/** Longest wait for the bundled terminal font before rendering anyway. */
const TERMINAL_FONT_LOAD_TIMEOUT_MS = 1500;

document.documentElement.lang = useLocaleStore.getState().locale;

async function start(): Promise<void> {
  // Dev-only browser preview: `vite` + `?mock` answers IPC with sample data.
  if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window && (window as { __TAURI_INTERNALS__?: { invoke?: unknown } }).__TAURI_INTERNALS__?.invoke)
    && new URLSearchParams(window.location.search).has("mock")) {
    const { installMockBackend } = await import("./dev/mockBackend");
    installMockBackend();
  }
  // xterm measures its cell size when a terminal opens and doesn't re-measure
  // when a web font arrives later, so the bundled font must be loaded first.
  await Promise.race([
    document.fonts.load(`16px '${BUNDLED_TERMINAL_FONT}'`).catch((error: unknown) => console.warn("terminal font failed to load:", error)),
    new Promise((resolve) => setTimeout(resolve, TERMINAL_FONT_LOAD_TIMEOUT_MS)),
  ]);
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <SystemRoot />
    </React.StrictMode>,
  );
}

void start();
