// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { EmptyState } from "./EmptyState";
import { LoadingScreen } from "./LoadingScreen";
import { ToastStack } from "./ToastStack";

describe("system surfaces", () => {
  it("announces empty and loading states accessibly", () => {
    render(
      <>
        <EmptyState description="Crie um projeto" title="Nenhum projeto" />
        <LoadingScreen phase="hydrating" progress={42} />
      </>,
    );

    expect(screen.getByRole("heading", { name: "Nenhum projeto" })).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Progresso da inicialização" })).toHaveAttribute("aria-valuenow", "42");
    expect(screen.getByRole("status")).toHaveTextContent("restaurando o workspace");
  });

  it("forwards toast dismissal from its close action", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(
      <ToastStack
        autoDismiss={false}
        onDismiss={onDismiss}
        toasts={[{ id: "toast-1", title: "Workspace pronto", tone: "success" }]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Dispensar: Workspace pronto" }));
    expect(onDismiss).toHaveBeenCalledWith("toast-1");
  });
});
