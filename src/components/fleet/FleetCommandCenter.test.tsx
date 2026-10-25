// @vitest-environment jsdom

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { buildAgentLabels } from "../../domain/agentLabels";
import { FleetCommandCenter } from "./FleetCommandCenter";
import type { Workspace } from "../../domain/workspace.model";

const workspaces: Workspace[] = [{
  id: "ws-api",
  name: "Terra API",
  cwd: "/tmp/terra-api",
  terminals: [
    { id: "term-claude", command: "claude", width: 100 },
    { id: "term-codex", command: "codex", width: 100 },
    { id: "term-idle", command: "opencode", width: 100, isSuspended: true },
  ],
}];

const labels = buildAgentLabels(workspaces, { titles: { "term-claude": "✳ Planejador de retomada" } });

describe("FleetCommandCenter", () => {
  it("Given a fleet, when it renders, then it summarizes the fleet and lists what needs the user first", async () => {
    const user = userEvent.setup();
    const onFocus = vi.fn();
    const onMarkRead = vi.fn();
    render(
      <FleetCommandCenter
        workspaces={workspaces}
        notifications={{ "term-claude": 1 }}
        labels={labels}
        attentionMessages={{ "term-claude": "Posso rodar npm test?" }}
        onFocus={onFocus}
        onMarkRead={onMarkRead}
      />,
    );

    expect(screen.getByRole("heading", { name: "Frota" })).toBeInTheDocument();
    expect(screen.getByText("3 agentes em 1 projeto")).toBeInTheDocument();
    const attention = screen.getByRole("region", { name: "Precisa de você" });
    expect(within(attention).getByText("Posso rodar npm test?")).toBeInTheDocument();
    expect(within(attention).getByText("Planejador de retomada")).toBeInTheDocument();

    await user.click(within(attention).getByRole("button", { name: "Abrir no Workbench →" }));
    expect(onFocus).toHaveBeenCalledWith("term-claude", "ws-api");
    await user.click(within(attention).getByRole("button", { name: "Marcar como lido" }));
    expect(onMarkRead).toHaveBeenCalledWith("term-claude");
  });

  it("Given a fleet, when filtering by state chip and by search, then the source fleet is kept", async () => {
    const user = userEvent.setup();
    render(<FleetCommandCenter workspaces={workspaces} labels={labels} />);

    await user.click(screen.getByRole("button", { name: /Suspenso · 1/ }));
    expect(screen.getAllByRole("row")).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: /Suspenso · 1/ }));
    expect(screen.getAllByRole("row")).toHaveLength(4);

    await user.type(screen.getByRole("searchbox", { name: "Buscar na frota" }), "zzz");
    expect(screen.getByText("Nenhum agente corresponde a esses filtros.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Limpar filtros" }));
    expect(screen.getAllByRole("row")).toHaveLength(4);
  });

  it("Given selected agents, when running a batch action, then it runs on them", async () => {
    const user = userEvent.setup();
    const onBatchAction = vi.fn();
    render(<FleetCommandCenter workspaces={workspaces} labels={labels} onBatchAction={onBatchAction} />);

    expect(screen.queryByRole("toolbar", { name: "Ações em lote" })).toBeNull();
    await user.click(screen.getByRole("checkbox", { name: "Selecionar codex" }));
    await user.click(screen.getByRole("checkbox", { name: "Selecionar opencode" }));
    const toolbar = screen.getByRole("toolbar", { name: "Ações em lote" });
    expect(toolbar).toHaveTextContent("2 selecionados");
    await user.click(within(toolbar).getByRole("button", { name: "Pausar" }));
    expect(onBatchAction).toHaveBeenCalledWith("stop", ["term-codex", "term-idle"]);
  });

  it("Given an agent row, when it is clicked, then the agent opens", async () => {
    const user = userEvent.setup();
    const onFocus = vi.fn();
    render(<FleetCommandCenter workspaces={workspaces} labels={labels} onFocus={onFocus} />);
    await user.click(screen.getByRole("button", { name: "Abrir codex em Terra API" }));
    expect(onFocus).toHaveBeenCalledWith("term-codex", "ws-api");
  });
});
