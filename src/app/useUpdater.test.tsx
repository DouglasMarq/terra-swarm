// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const updater = vi.hoisted(() => ({
  appVersion: vi.fn(),
  checkForUpdate: vi.fn(),
  installUpdate: vi.fn(),
}));

vi.mock("../lib/tauri/updater", () => updater);

import { useUpdater } from "./useUpdater";

const update = { version: "2.3.0", downloadAndInstall: vi.fn() };

describe("useUpdater", () => {
  beforeEach(() => {
    for (const fn of Object.values(updater)) fn.mockReset();
    updater.appVersion.mockResolvedValue("2.2.1");
    updater.installUpdate.mockResolvedValue(undefined);
  });

  it("Given a newer release, when the hook checks on mount, then it shows the version and installs that update", async () => {
    updater.checkForUpdate.mockResolvedValue({ kind: "update", version: "2.3.0", current: "2.2.1", update });

    const { result } = renderHook(() => useUpdater());

    await waitFor(() => expect(result.current.updateVersion).toBe("2.3.0"));
    expect(result.current.appVersion).toBe("2.2.1");
    act(() => result.current.installUpdate());
    expect(result.current.isUpdateInstalling).toBe(true);
    expect(updater.installUpdate).toHaveBeenCalledWith(update);
  });

  it("Given no release, when checking manually, then it reports the app is up to date", async () => {
    updater.checkForUpdate.mockResolvedValue({ kind: "none" });
    const { result } = renderHook(() => useUpdater());

    act(() => result.current.manualUpdateCheck());

    await waitFor(() => expect(result.current.updateCheckState).toBe("uptodate"));
  });

  it("Given a failing check, when checking manually, then it reports the error", async () => {
    updater.checkForUpdate.mockResolvedValueOnce({ kind: "none" }).mockResolvedValueOnce({ kind: "error" });
    const { result } = renderHook(() => useUpdater());

    act(() => result.current.manualUpdateCheck());

    await waitFor(() => expect(result.current.updateCheckState).toBe("error"));
  });

  it("Given a failing install, when installing, then it stops installing and tells the user", async () => {
    updater.checkForUpdate.mockResolvedValue({ kind: "none" });
    updater.installUpdate.mockRejectedValue(new Error("signature mismatch"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { result } = renderHook(() => useUpdater());

    act(() => result.current.installUpdate());

    await waitFor(() => expect(result.current.isUpdateInstalling).toBe(false));
    expect(updater.installUpdate).toHaveBeenCalledWith(null);
  });
});
