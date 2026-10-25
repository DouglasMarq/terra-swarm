import { create } from "zustand";
import { onDevServer, previewApi } from "../lib/tauri/preview";

const MAX_DETECTED_URLS = 12;

/** Ports dev servers usually take, tried when nothing was printed. */
export const COMMON_DEV_PORTS: readonly number[] = [3000, 3001, 4200, 4321, 5000, 5173, 5174, 8000, 8080, 8081, 8888, 9000];

/** Only pages served from this machine may load in the panel. */
export function loopbackUrl(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  const withScheme = /^[a-z]+:\/\//i.test(text) ? text : /^\d+$/.test(text) ? `http://localhost:${text}/` : `http://${text}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return null;
  if (url.username || url.password) return null;
  return url.toString();
}

export interface PreviewState {
  /** Detected URLs per workspace, newest first. */
  detected: Record<string, string[]>;
  /** The URL each workspace's panel shows. */
  selected: Record<string, string>;
  probing: boolean;
  addDetected: (workspaceId: string, url: string) => void;
  select: (workspaceId: string, url: string) => void;
  /** Look for listening dev servers; `exclude` is Terra's own MCP port. */
  probe: (workspaceId: string, exclude?: number | null) => Promise<void>;
  reset: () => void;
}

export const usePreviewStore = create<PreviewState>((set, get) => ({
  detected: {},
  selected: {},
  probing: false,

  addDetected: (workspaceId, url) => {
    const clean = loopbackUrl(url);
    if (!clean) return;
    set((state) => {
      const list = [clean, ...(state.detected[workspaceId] ?? []).filter((item) => item !== clean)].slice(0, MAX_DETECTED_URLS);
      const selected = state.selected[workspaceId] ? state.selected : { ...state.selected, [workspaceId]: clean };
      return { detected: { ...state.detected, [workspaceId]: list }, selected };
    });
  },

  select: (workspaceId, url) => {
    const clean = loopbackUrl(url);
    if (clean) set((state) => ({ selected: { ...state.selected, [workspaceId]: clean } }));
  },

  probe: async (workspaceId, exclude = null) => {
    set({ probing: true });
    try {
      const ports = await previewApi.probeDevServers(COMMON_DEV_PORTS.filter((port) => port !== exclude));
      for (const port of [...ports].reverse()) get().addDetected(workspaceId, `http://localhost:${port}/`);
    } catch (error) {
      console.warn("dev server probe failed:", error);
    } finally {
      set({ probing: false });
    }
  },

  reset: () => set({ detected: {}, selected: {}, probing: false }),
}));

/** Collect the URLs terminals print, per workspace. */
export function startPreviewBridge(): () => void {
  const pending = onDevServer((payload) => {
    if (payload?.workspace_id && payload.url) usePreviewStore.getState().addDetected(payload.workspace_id, payload.url);
  });
  return () => void pending.then((stop) => stop()).catch((error) => console.warn("failed to stop listening for dev servers:", error));
}
