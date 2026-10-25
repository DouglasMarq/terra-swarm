// @vitest-environment jsdom

import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ readWorkspaceFile: vi.fn(), writeWorkspaceFile: vi.fn() }));
vi.mock("../../api", () => ({ api }));
vi.mock("./CodeEditor", () => ({
  default: ({ initial, onChange }: { initial: string; onChange: (text: string) => void }) => (
    <textarea aria-label="code" defaultValue={initial} onChange={(event) => onChange(event.target.value)} />
  ),
}));

import { IpcError } from "../../lib/tauri/errors";
import { useEditorStore } from "../../stores/editorStore";
import { FileEditorDialog } from "./FileEditorDialog";

describe("FileEditorDialog", () => {
  beforeEach(() => {
    api.readWorkspaceFile.mockReset();
    api.writeWorkspaceFile.mockReset();
    api.readWorkspaceFile.mockResolvedValue({ path: "src/a.ts", content: "one", isBinary: false, size: 3, modified: 10 });
  });

  afterEach(() => act(() => useEditorStore.getState().close()));

  it("Given a file an agent changed, when saving, then it saves with the read time and offers an overwrite", async () => {
    api.writeWorkspaceFile.mockRejectedValueOnce(new IpcError({ code: "changedOnDisk", message: "the file changed on disk since it was opened" }));
    api.writeWorkspaceFile.mockResolvedValueOnce({ size: 3, modified: 20 });
    render(<FileEditorDialog />);
    act(() => useEditorStore.getState().open({ workspaceId: "ws", path: "src/a.ts" }));

    fireEvent.change(await screen.findByLabelText("code"), { target: { value: "two" } });
    await userEvent.click(screen.getByRole("button", { name: /salvar/i }));
    expect(api.writeWorkspaceFile).toHaveBeenLastCalledWith("ws", "src/a.ts", "two", 10);
    await userEvent.click(await screen.findByRole("button", { name: /sobrescrever/i }));
    expect(api.writeWorkspaceFile).toHaveBeenLastCalledWith("ws", "src/a.ts", "two", null);
    expect(await screen.findByRole("button", { name: /salvar/i })).toBeTruthy();
  });

  it("Given a save that fails for another reason, when saving, then it shows the error without offering an overwrite", async () => {
    api.writeWorkspaceFile.mockRejectedValueOnce(new IpcError({ code: "other", message: "cannot save the file: disk full" }));
    render(<FileEditorDialog />);
    act(() => useEditorStore.getState().open({ workspaceId: "ws", path: "src/a.ts" }));

    fireEvent.change(await screen.findByLabelText("code"), { target: { value: "two" } });
    await userEvent.click(screen.getByRole("button", { name: /salvar/i }));
    expect(await screen.findByText("cannot save the file: disk full")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /sobrescrever/i })).toBeNull();
  });

  it("Given a binary file, when opening it, then the editor does not open it", async () => {
    api.readWorkspaceFile.mockResolvedValue({ path: "logo.png", content: "", isBinary: true, size: 9, modified: 1 });
    render(<FileEditorDialog />);
    act(() => useEditorStore.getState().open({ workspaceId: "ws", path: "logo.png" }));
    expect(await screen.findByText(/binário/i)).toBeTruthy();
    expect(screen.queryByLabelText("code")).toBeNull();
  });
});
