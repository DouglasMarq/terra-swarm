// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { HomeDashboard } from "./HomeDashboard";
import homeStyles from "./home.css?raw";

describe("HomeDashboard", () => {
  it("dispatches quick actions and opens recent workspaces", async () => {
    const user = userEvent.setup();
    const onQuickAction = vi.fn();
    const onOpenWorkspace = vi.fn();
    render(
      <HomeDashboard
        greeting="Bom dia"
        onOpenWorkspace={onOpenWorkspace}
        onQuickAction={onQuickAction}
        pulse={{ activeAgents: 2, totalAgents: 3, throughput: "8/min", note: "Stable" }}
        quickActions={[{ id: "new-agent", label: "Novo Luna", description: "Executar Luna Max" }]}
        recentWorkspaces={[{ id: "ws-1", name: "Terra API", detail: "main", agentCount: 1 }]}
      />,
    );

    expect(screen.getByRole("heading", { name: "Bom dia" })).toBeInTheDocument();
    expect(screen.getByText("2/3")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Novo Luna/ }));
    await user.click(screen.getByRole("button", { name: /Terra API/ }));

    expect(onQuickAction).toHaveBeenCalledWith("new-agent");
    expect(onOpenWorkspace).toHaveBeenCalledWith("ws-1");
  });

  it("keeps quick actions on the dashboard without a duplicate launcher", async () => {
    const user = userEvent.setup();
    const onQuickAction = vi.fn();
    render(
      <HomeDashboard
        quickActions={[{ id: "open-fleet", label: "Abrir Fleet", description: "Ver agentes" }]}
        onQuickAction={onQuickAction}
      />,
    );

    expect(screen.queryByRole("button", { name: "Ações rápidas" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Voz" })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Ações rápidas" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Abrir Fleet/ }));
    expect(onQuickAction).toHaveBeenCalledWith("open-fleet");
  });

  it("keeps only non-duplicated home metrics", () => {
    render(
      <HomeDashboard
        pulse={{ activeAgents: 2, totalAgents: 3, queuedRuns: 1, completedRuns: 4 }}
      />,
    );

    expect(screen.getByText("Concluídas")).toBeInTheDocument();
    expect(screen.queryByText("Execuções ativas", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText("Na fila", { exact: true })).not.toBeInTheDocument();
  });

  it("keeps the pulse count and caption in a responsive vertical summary", () => {
    render(<HomeDashboard pulse={{ activeAgents: 1, totalAgents: 1 }} />);

    expect(screen.getByText("1/1")).toHaveClass("terra-home-pulse-value");
    expect(screen.getByText("agentes em execução")).toHaveClass("terra-home-pulse-caption");
    expect(homeStyles).toMatch(
      /\.terra-home-pulse-summary\s*\{[\s\S]*?display:\s*flex;[\s\S]*?flex-direction:\s*column;/,
    );
    expect(homeStyles).toMatch(
      /\.terra-home-pulse-caption\s*\{[\s\S]*?white-space:\s*nowrap;/,
    );
    expect(homeStyles).toMatch(
      /@media\s*\(max-width:\s*480px\)[\s\S]*?\.terra-home-pulse-note\s*\{[\s\S]*?grid-column:\s*1\s*\/\s*-1;/,
    );
  });

  it("keeps the home inner surface within the scroll viewport", () => {
    expect(homeStyles).toMatch(
      /\.terra-home-inner\s*\{[\s\S]*?min-height:\s*100%;[\s\S]*?box-sizing:\s*border-box;/,
    );
    expect(homeStyles).toMatch(/\.terra-home-metrics\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1\.8fr\)\s+minmax\(120px, 1fr\);/);
    expect(homeStyles).not.toMatch(/\.terra-home-launcher/);
  });
});
