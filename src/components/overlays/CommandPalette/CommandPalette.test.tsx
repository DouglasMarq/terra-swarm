// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CommandPalette } from "./CommandPalette";
import type { Workspace } from "../../../domain/workspace.model";

const workspaces: Workspace[] = [{ id: "ws-1", name: "Terra API", cwd: "/tmp/api", terminals: [] }];

describe("CommandPalette", () => {
  it("searches commands and dispatches the selected route", async () => {
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
