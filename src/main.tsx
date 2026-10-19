import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/geist";
import "./styles/index.css";
import { SystemRoot } from "./components/integration/SystemRoot";
import { useLocaleStore } from "./i18n";

document.documentElement.lang = useLocaleStore.getState().locale;

async function start(): Promise<void> {
  // Dev-only browser preview: `vite` + `?mock` answers IPC with sample data.
  if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window && (window as { __TAURI_INTERNALS__?: { invoke?: unknown } }).__TAURI_INTERNALS__?.invoke)
    && new URLSearchParams(window.location.search).has("mock")) {
    const { installMockBackend } = await import("./dev/mockBackend");
    installMockBackend();
  }
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <SystemRoot />
    </React.StrictMode>,
  );
}

void start();
