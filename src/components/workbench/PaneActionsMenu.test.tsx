// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PaneActionsMenu } from "./PaneActionsMenu";

describe("PaneActionsMenu", () => {
  it("Given the pane menu, when an action is picked, then the grouped actions open, the action runs and the menu closes", async () => {
    const user = userEvent.setup();
    const restart = vi.fn();
    const kill = vi.fn();
    render(
      <PaneActionsMenu
        label="Mais ações"
        groups={[
          [{ id: "restart", label: "Reiniciar", shortcut: "⌘R", onSelect: restart }],
          [{ id: "copy", label: "Copiar comando de retomada", detail: "claude --continue", onSelect: vi.fn() }],
          [{ id: "kill", label: "Encerrar sessão…", isDanger: true, onSelect: kill }],
        ]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Mais ações" }));
    const menu = screen.getByRole("menu", { name: "Mais ações" });
    expect(menu.querySelectorAll('[role="group"]')).toHaveLength(3);
    expect(screen.getByText("claude --continue")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Encerrar sessão…" })).toHaveAttribute("data-danger", "true");

    await user.click(screen.getByRole("menuitem", { name: /Reiniciar/ }));
    expect(restart).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("Given an open pane menu, when pressing Escape, then it closes", async () => {
    const user = userEvent.setup();
    render(<PaneActionsMenu label="Mais ações" groups={[[{ id: "a", label: "A", onSelect: vi.fn() }]]} />);
    await user.click(screen.getByRole("button", { name: "Mais ações" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
