// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ readWorkspaceFile: vi.fn(), writeWorkspaceFile: vi.fn() }));
vi.mock("../api", () => ({ api }));

import { IpcError } from "../lib/tauri/errors";
import type { EditorTarget } from "../stores/editorStore";
import { useFileEditor } from "./useFileEditor";

const target: EditorTarget = { workspaceId: "ws-1", path: "src/a.ts" };

async function loaded() {
  const hook = renderHook(() => useFileEditor(target));
  await waitFor(() => expect(hook.result.current.file).not.toBeNull());
  return hook;
}

describe("useFileEditor", () => {
  beforeEach(() => {
    api.readWorkspaceFile.mockReset().mockResolvedValue({ path: "src/a.ts", content: "one", binary: false, size: 3, modified: 10 });
    api.writeWorkspaceFile.mockReset();
  });

  it("given a target, reads the file into the editor text", async () => {
    const { result } = await loaded();
    expect(api.readWorkspaceFile).toHaveBeenCalledWith("ws-1", "src/a.ts");
    expect(result.current.text).toBe("one");
    expect(result.current.isDirty).toBe(false);
  });

  it("given the file can't be read, reports the error", async () => {
    api.readWorkspaceFile.mockRejectedValue("file is unavailable");
    const { result } = renderHook(() => useFileEditor(target));
    await waitFor(() => expect(result.current.loadError).toBe("file is unavailable"));
    expect(result.current.file).toBeNull();
  });

  it("given an edit that saves, keeps the new text as the file's content", async () => {
    api.writeWorkspaceFile.mockResolvedValue({ size: 3, modified: 20 });
    const { result } = await loaded();
    act(() => result.current.setText("two"));
    expect(result.current.isDirty).toBe(true);

    let saved = false;
    await act(async () => {
      saved = await result.current.save();
    });

    expect(saved).toBe(true);
    expect(api.writeWorkspaceFile).toHaveBeenCalledWith("ws-1", "src/a.ts", "two", 10);
    expect(result.current.isDirty).toBe(false);
    expect(result.current.file?.modified).toBe(20);
  });

  it("given the file changed on disk, reports a conflict that an overwrite clears", async () => {
    api.writeWorkspaceFile
      .mockRejectedValueOnce(new IpcError({ code: "changedOnDisk", message: "the file changed on disk" }))
      .mockResolvedValueOnce({ size: 3, modified: 30 });
    const { result } = await loaded();
    act(() => result.current.setText("two"));

    await act(async () => {
      await result.current.save();
    });
    expect(result.current.hasConflict).toBe(true);
    expect(result.current.saveError).toBe("the file changed on disk");

    await act(async () => {
      await result.current.save(true);
    });
    expect(api.writeWorkspaceFile).toHaveBeenLastCalledWith("ws-1", "src/a.ts", "two", null);
    expect(result.current.hasConflict).toBe(false);
  });

  it("given a save that fails for another reason, reports it without a conflict", async () => {
    api.writeWorkspaceFile.mockRejectedValue(new IpcError({ code: "other", message: "the text is too large to save here" }));
    const { result } = await loaded();
    act(() => result.current.setText("two"));

    let saved = true;
    await act(async () => {
      saved = await result.current.save();
    });

    expect(saved).toBe(false);
    expect(result.current.hasConflict).toBe(false);
    expect(result.current.saveError).toBe("the text is too large to save here");
  });
});
