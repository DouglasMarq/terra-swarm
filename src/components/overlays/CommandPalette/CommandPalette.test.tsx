// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CommandPalette } from "./CommandPalette";
import type { Workspace } from "../../../domain/workspace.model";

const workspaces: Workspace[] = [{ id: "ws-1", name: "Terra API", cwd: "/tmp/api", terminals: [] }];

describe("CommandPalette", () => {
  it("Given the command palette, when searching and selecting a command, then the selected route is dispatched", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const onNavigate = vi.fn();
    render(
      <CommandPalette
        callbacks={{ onNavigate }}
        onOpenChange={onOpenChange}
        isOpen
        workspaces={workspaces}
      />,
    );

    const input = screen.getByPlaceholderText("Buscar comando, projeto ou agente…");
    await user.type(input, "fleet");
    const command = screen.getByRole("option", { name: /Abrir a Frota/ });
    expect(command).toBeVisible();
    await user.click(command);

    expect(onNavigate).toHaveBeenCalledWith("fleet");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe("CommandPalette outcomes", () => {
  it("Given a destructive command and a confirm handler, when selecting it, then the palette hands over the request and closes", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const onRequestConfirm = vi.fn();
    const onImportWorkspace = vi.fn();
    render(
      <CommandPalette callbacks={{ onImportWorkspace }} onOpenChange={onOpenChange} onRequestConfirm={onRequestConfirm} isOpen workspaces={workspaces} />,
    );

    await user.type(screen.getByRole("combobox"), "importar");
    await user.click(screen.getByRole("option", { name: /Importar workspace…/ }));

    expect(onRequestConfirm).toHaveBeenCalledWith(expect.objectContaining({ kind: "import-snapshot" }));
    expect(onImportWorkspace).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("Given a destructive command without a confirm handler, when selecting it, then the palette stays open", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<CommandPalette onOpenChange={onOpenChange} isOpen workspaces={workspaces} />);

    await user.type(screen.getByRole("combobox"), "importar");
    await user.click(screen.getByRole("option", { name: /Importar workspace…/ }));

    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("Given a command the host cannot run, when selecting it, then the palette says it is unavailable", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const view = render(<CommandPalette onOpenChange={onOpenChange} isOpen workspaces={workspaces} />);

    await user.type(screen.getByRole("combobox"), "fleet");
    await user.click(screen.getByRole("option", { name: /Abrir a Frota/ }));

    expect(screen.getByText("Este comando ainda não está disponível neste contexto.")).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();

    view.rerender(<CommandPalette onOpenChange={onOpenChange} isOpen={false} workspaces={workspaces} />);
    view.rerender(<CommandPalette onOpenChange={onOpenChange} isOpen workspaces={workspaces} />);
    expect(screen.getByRole("combobox")).toHaveValue("");
    expect(screen.queryByText("Este comando ainda não está disponível neste contexto.")).not.toBeInTheDocument();
  });

  it("Given a query that matches nothing, when typing, then an empty message shows", async () => {
    const user = userEvent.setup();
    render(<CommandPalette onOpenChange={vi.fn()} isOpen workspaces={workspaces} />);

    await user.type(screen.getByRole("combobox"), "xyzzy");

    expect(screen.getByText("Nenhum comando encontrado")).toBeInTheDocument();
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
  });
});
