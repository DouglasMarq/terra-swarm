// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

function footerClose(): HTMLElement {
  const button = screen.getAllByRole("button", { name: "Fechar" }).find((candidate) => candidate.textContent?.trim() === "Fechar");
  if (!button) throw new Error("the footer close button is missing");
  return button;
}

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
    expect(api.writeWorkspaceFile).toHaveBeenLastCalledWith({ workspaceId: "ws", relativePath: "src/a.ts", content: "two", expectedModified: 10 });
    await userEvent.click(await screen.findByRole("button", { name: /sobrescrever/i }));
    expect(api.writeWorkspaceFile).toHaveBeenLastCalledWith({ workspaceId: "ws", relativePath: "src/a.ts", content: "two", expectedModified: null });
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

  it("Given a file that cannot be read, when opening it, then the reason is shown and saving is off", async () => {
    api.readWorkspaceFile.mockRejectedValue(new Error("permission denied"));
    render(<FileEditorDialog />);
    act(() => useEditorStore.getState().open({ workspaceId: "ws", path: "src/a.ts" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("permission denied");
    expect(screen.getByRole("button", { name: /salvar/i })).toBeDisabled();
  });

  it("Given unsaved changes, when closing, then it asks first and the second close discards them", async () => {
    const user = userEvent.setup();
    render(<FileEditorDialog />);
    act(() => useEditorStore.getState().open({ workspaceId: "ws", path: "src/a.ts" }));

    fireEvent.change(await screen.findByLabelText("code"), { target: { value: "two" } });
    expect(screen.getByLabelText("Alterações não salvas")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.getByText("Há alterações não salvas. Fechar mesmo assim e perdê-las?")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Descartar e fechar" }));

    expect(useEditorStore.getState().target).toBeNull();
  });

  it("Given a clean file, when closing, then it closes at once", async () => {
    const user = userEvent.setup();
    render(<FileEditorDialog />);
    act(() => useEditorStore.getState().open({ workspaceId: "ws", path: "src/a.ts" }));

    await screen.findByLabelText("code");
    await user.click(footerClose());

    expect(useEditorStore.getState().target).toBeNull();
  });

  it("Given a conflict while a discard is pending, when reloading from disk, then the file is read again and the prompt clears", async () => {
    const user = userEvent.setup();
    api.writeWorkspaceFile.mockRejectedValueOnce(new IpcError({ code: "changedOnDisk", message: "the file changed on disk since it was opened" }));
    api.readWorkspaceFile.mockResolvedValueOnce({ path: "src/a.ts", content: "one", isBinary: false, size: 3, modified: 10 });
    api.readWorkspaceFile.mockResolvedValueOnce({ path: "src/a.ts", content: "agent edit", isBinary: false, size: 10, modified: 30 });
    render(<FileEditorDialog />);
    act(() => useEditorStore.getState().open({ workspaceId: "ws", path: "src/a.ts" }));

    fireEvent.change(await screen.findByLabelText("code"), { target: { value: "two" } });
    await user.click(screen.getByRole("button", { name: /salvar/i }));
    await user.click(footerClose());
    await user.click(await screen.findByRole("button", { name: "Recarregar do disco" }));

    expect(await screen.findByDisplayValue("agent edit")).toBeInTheDocument();
    expect(screen.queryByText("Há alterações não salvas. Fechar mesmo assim e perdê-las?")).not.toBeInTheDocument();
    expect(api.readWorkspaceFile).toHaveBeenCalledTimes(2);
  });

  it("Given a pending discard, when the save succeeds, then the prompt clears", async () => {
    const user = userEvent.setup();
    api.writeWorkspaceFile.mockResolvedValueOnce({ size: 3, modified: 20 });
    render(<FileEditorDialog />);
    act(() => useEditorStore.getState().open({ workspaceId: "ws", path: "src/a.ts" }));

    fireEvent.change(await screen.findByLabelText("code"), { target: { value: "two" } });
    await user.click(footerClose());
    await user.click(screen.getByRole("button", { name: /salvar/i }));

    await waitFor(() => expect(footerClose()).toBeInTheDocument());
    expect(useEditorStore.getState().target).not.toBeNull();
  });
});
