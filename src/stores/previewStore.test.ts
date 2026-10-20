import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ probeDevServers: vi.fn() }));
vi.mock("../lib/tauri/preview", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/tauri/preview")>()),
  previewApi: api,
}));

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { listen } from "@tauri-apps/api/event";
import { loopbackUrl, startPreviewBridge, usePreviewStore } from "./previewStore";

describe("preview store", () => {
  afterEach(() => usePreviewStore.getState().reset());

  it("accepts only loopback pages", () => {
    expect(loopbackUrl("5173")).toBe("http://localhost:5173/");
    expect(loopbackUrl("localhost:3000/app")).toBe("http://localhost:3000/app");
    expect(loopbackUrl("http://127.0.0.1:8000")).toBe("http://127.0.0.1:8000/");
    expect(loopbackUrl("https://example.com")).toBeNull();
    expect(loopbackUrl("file:///etc/passwd")).toBeNull();
    expect(loopbackUrl("javascript:alert(1)")).toBeNull();
    expect(loopbackUrl("http://user:pw@localhost:3000")).toBeNull();
    expect(loopbackUrl("")).toBeNull();
  });

  it("keeps the newest detection first and selects the first one found", () => {
    const store = usePreviewStore.getState();
    store.addDetected("ws", "http://localhost:5173/");
    store.addDetected("ws", "http://localhost:3000/");
    store.addDetected("ws", "http://localhost:5173/");
    store.addDetected("ws", "https://evil.example/");
    expect(usePreviewStore.getState().detected.ws).toEqual(["http://localhost:5173/", "http://localhost:3000/"]);
    expect(usePreviewStore.getState().selected.ws).toBe("http://localhost:5173/");
  });

  it("probes common ports without Terra's own", async () => {
    api.probeDevServers.mockResolvedValue([3000, 8080]);
    await usePreviewStore.getState().probe("ws", 5173);
    expect(api.probeDevServers.mock.calls[0][0]).not.toContain(5173);
    expect(usePreviewStore.getState().detected.ws).toEqual(["http://localhost:3000/", "http://localhost:8080/"]);
  });
});

describe("startPreviewBridge", () => {
  it("given the listener fails to register, warns when stopped instead of swallowing it", async () => {
    vi.mocked(listen).mockRejectedValueOnce(new Error("no event bus"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stop = startPreviewBridge();
    stop();
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith("failed to stop listening for dev servers:", expect.any(Error)));
    warn.mockRestore();
  });
});
