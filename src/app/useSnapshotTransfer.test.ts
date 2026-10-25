// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceSnapshotTransfer } from "../domain/workspace.model";

const dialogs = vi.hoisted(() => ({
  saveDialog: vi.fn<() => Promise<string | null>>(),
  openDialog: vi.fn<() => Promise<string | null>>(),
}));
const apiMock = vi.hoisted(() => ({
  exportWorkspaceSnapshot: vi.fn<(path: string) => Promise<WorkspaceSnapshotTransfer>>(),
  importWorkspaceSnapshot: vi.fn<(path: string) => Promise<WorkspaceSnapshotTransfer>>(),
}));

vi.mock("../lib/tauri/system", () => dialogs);
vi.mock("../api", () => ({ api: apiMock }));

import { useTerminalRuntimeStore } from "../stores/terminalRuntimeStore";
import { useUiStore } from "../stores/uiStore";
import { useSnapshotTransfer } from "./useSnapshotTransfer";

function transfer(fields: Partial<WorkspaceSnapshotTransfer>): WorkspaceSnapshotTransfer {
  return {
    version: 2,
    path: "/backups/terra.json",
    backupPath: null,
    workspaceCount: 2,
    groupCount: 0,
    terminalCount: 3,
    suspendedTerminalCount: 3,
    ...fields,
  };
}

function renderTransfer() {
  const sessions = { forgetAll: vi.fn(() => ["term-one"]) };
  const refresh = vi.fn(() => Promise.resolve());
  const { result } = renderHook(() => useSnapshotTransfer(sessions, refresh));
  return { result, sessions, refresh };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  useUiStore.setState({ expandedId: "term-one", focusedId: "term-one" });
});

describe("useSnapshotTransfer", () => {
  it("Given a chosen destination, when exporting, then the snapshot is written and the result is reported", async () => {
    dialogs.saveDialog.mockResolvedValue("/backups/terra.json");
    apiMock.exportWorkspaceSnapshot.mockResolvedValue(transfer({}));
    const { result } = renderTransfer();

    await act(() => result.current.exportSnapshot());

    expect(apiMock.exportWorkspaceSnapshot).toHaveBeenCalledWith("/backups/terra.json");
    expect(result.current.feedback).toMatchObject({ kind: "success", backupPath: "/backups/terra.json", pathKind: "file" });
    expect(result.current.operation).toBeNull();
  });

  it("Given a cancelled save picker, when exporting, then nothing is written", async () => {
    dialogs.saveDialog.mockResolvedValue(null);
    const { result } = renderTransfer();

    await act(() => result.current.exportSnapshot());

    expect(apiMock.exportWorkspaceSnapshot).not.toHaveBeenCalled();
    expect(result.current.feedback).toBeNull();
  });

  it("Given a failing backend, when exporting, then an error is reported", async () => {
    dialogs.saveDialog.mockResolvedValue("/backups/terra.json");
    apiMock.exportWorkspaceSnapshot.mockRejectedValue(new Error("disk full"));
    const { result } = renderTransfer();

    await act(() => result.current.exportSnapshot());

    expect(result.current.feedback?.kind).toBe("error");
  });

  it("Given a picked file, when the import is confirmed, then runtime state is cleared and the backup is reported", async () => {
    dialogs.openDialog.mockResolvedValue("/backups/terra.json");
    apiMock.importWorkspaceSnapshot.mockResolvedValue(transfer({ backupPath: "/backups/before-import.json" }));
    const { result, sessions, refresh } = renderTransfer();

    await act(() => result.current.pickImport());
    expect(result.current.pendingImportPath).toBe("/backups/terra.json");
    await act(() => result.current.confirmImport());

    expect(apiMock.importWorkspaceSnapshot).toHaveBeenCalledWith("/backups/terra.json");
    expect(sessions.forgetAll).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(useUiStore.getState()).toMatchObject({ expandedId: null, focusedId: null });
    expect(useTerminalRuntimeStore.getState().resumeItems).toBeNull();
    expect(result.current.feedback).toMatchObject({ kind: "success", backupPath: "/backups/before-import.json", pathKind: "backup" });
    expect(result.current.pendingImportPath).toBeNull();
  });

  it("Given a picked file, when the import is cancelled, then nothing is imported", async () => {
    dialogs.openDialog.mockResolvedValue("/backups/terra.json");
    const { result } = renderTransfer();

    await act(() => result.current.pickImport());
    act(() => result.current.cancelImport());
    await act(() => result.current.confirmImport());

    expect(apiMock.importWorkspaceSnapshot).not.toHaveBeenCalled();
  });

  it("Given a failing backend, when the import is confirmed, then an error is reported and the store is kept", async () => {
    dialogs.openDialog.mockResolvedValue("/backups/terra.json");
    apiMock.importWorkspaceSnapshot.mockRejectedValue(new Error("bad file"));
    const { result, sessions } = renderTransfer();

    await act(() => result.current.pickImport());
    await act(() => result.current.confirmImport());

    expect(sessions.forgetAll).not.toHaveBeenCalled();
    expect(result.current.feedback?.kind).toBe("error");
  });
});
