// @vitest-environment jsdom

import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ readWorkspaceFile: vi.fn(), writeWorkspaceFile: vi.fn() }));
vi.mock("../../api", () => ({ api }));
// CodeMirror needs a real layout engine; a textarea stands in for it.
vi.mock("./CodeEditor", () => ({
  default: ({ initial, onChange }: { initial: string; onChange: (text: string) => void }) => (
    <textarea aria-label="code" defaultValue={initial} onChange={(event) => onChange(event.target.value)} />
  ),
}));

import { useEditorStore } from "../../stores/editorStore";
import { FileEditorDialog } from "./FileEditorDialog";

describe("FileEditorDialog", () => {
  beforeEach(() => {
    api.readWorkspaceFile.mockReset();
    api.writeWorkspaceFile.mockReset();
    api.readWorkspaceFile.mockResolvedValue({ path: "src/a.ts", content: "one", binary: false, size: 3, modified: 10 });
  });

  afterEach(() => act(() => useEditorStore.getState().close()));

  it("saves with the read time, and offers overwrite when an agent changed the file", async () => {
    api.writeWorkspaceFile.mockRejectedValueOnce(new Error("the file changed on disk since it was opened"));
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

  it("does not open binary files", async () => {
    api.readWorkspaceFile.mockResolvedValue({ path: "logo.png", content: "", binary: true, size: 9, modified: 1 });
    render(<FileEditorDialog />);
    act(() => useEditorStore.getState().open({ workspaceId: "ws", path: "logo.png" }));
    expect(await screen.findByText(/binário/i)).toBeTruthy();
    expect(screen.queryByLabelText("code")).toBeNull();
  });
});
