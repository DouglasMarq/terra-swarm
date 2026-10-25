// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PaneActionsMenu } from "./PaneActionsMenu";

const MENU_HEIGHT_PX = 100;

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

  it("Given an open pane menu, when using the arrow keys, then focus cycles through the enabled actions", async () => {
    const user = userEvent.setup();
    render(
      <PaneActionsMenu
        label="Mais ações"
        groups={[
          [{ id: "first", label: "Primeira", onSelect: vi.fn() }],
          [],
          [
            { id: "off", label: "Desligada", isDisabled: true, onSelect: vi.fn() },
            { id: "last", label: "Última", onSelect: vi.fn() },
          ],
        ]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Mais ações" }));
    expect(screen.getByRole("menu").querySelectorAll('[role="group"]')).toHaveLength(2);
    expect(screen.getByRole("menuitem", { name: "Primeira" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Última" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Primeira" })).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(screen.getByRole("menuitem", { name: "Última" })).toHaveFocus();
    await user.keyboard("{Escape}");

    expect(screen.getByRole("button", { name: "Mais ações" })).toHaveFocus();
  });

  it("Given an open pane menu, when pressing inside it and then outside it, then only the outside press closes it", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <PaneActionsMenu label="Mais ações" groups={[[{ id: "first", label: "Primeira", onSelect: vi.fn() }]]} />
        <button type="button">Fora</button>
      </div>,
    );

    await user.click(screen.getByRole("button", { name: "Mais ações" }));
    fireEvent.pointerDown(screen.getByRole("menuitem", { name: "Primeira" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Fora" }));

    expect(screen.queryByRole("menu")).toBeNull();
  });

  it.fails("Given an open pane menu, when clicking its trigger again in an engine that focuses buttons on click, then it closes", async () => {
    const user = userEvent.setup();
    render(<PaneActionsMenu label="Mais ações" groups={[[{ id: "first", label: "Primeira", onSelect: vi.fn() }]]} />);
    const trigger = screen.getByRole("button", { name: "Mais ações" });

    await user.click(trigger);
    await user.click(trigger);

    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("Given an open pane menu, when focus leaves it, then it closes", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <PaneActionsMenu label="Mais ações" groups={[[{ id: "first", label: "Primeira", onSelect: vi.fn() }]]} />
        <button type="button">Fora</button>
      </div>,
    );

    await user.click(screen.getByRole("button", { name: "Mais ações" }));
    fireEvent.blur(screen.getByRole("menuitem", { name: "Primeira" }), { relatedTarget: screen.getByRole("button", { name: "Fora" }) });

    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("Given a trigger near the bottom of the window, when the menu opens, then it is placed above the trigger", async () => {
    const user = userEvent.setup();
    const triggerRect = { top: 700, bottom: 720, left: 300, right: 340, width: 40, height: 20, x: 300, y: 700, toJSON: () => ({}) };
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(triggerRect);
    const heightSpy = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(MENU_HEIGHT_PX);
    render(<PaneActionsMenu label="Mais ações" groups={[[{ id: "first", label: "Primeira", onSelect: vi.fn() }]]} />);

    await user.click(screen.getByRole("button", { name: "Mais ações" }));

    expect(screen.getByRole("menu")).toHaveStyle({ top: "596px" });
    rectSpy.mockRestore();
    heightSpy.mockRestore();
  });
});
