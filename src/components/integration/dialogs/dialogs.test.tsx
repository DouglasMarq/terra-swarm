// @vitest-environment jsdom

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { AgentInfo, ResumeItem } from "../../../types";
import { ResumeDialog } from "../../ResumeDialog";
import { AgentPickerDialog, RenameDialog, WorkspaceDialog } from ".";

const agents: AgentInfo[] = [
  { id: "codex", label: "Codex", available: true },
  { id: "claude", label: "Claude", available: false },
];

const resumeItem: ResumeItem = {
  agentId: "codex",
  command: "codex",
  cwd: "/tmp/project",
  resumeCommand: "codex resume --last",
  terminalId: "term-1",
  wsId: "ws-1",
  wsName: "Terra",
};

describe("integration dialogs", () => {
  it("validates and submits the workspace form with Enter", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <WorkspaceDialog
        cwd=""
        name=""
        onBrowse={vi.fn()}
        onCwdChange={vi.fn()}
        onNameChange={vi.fn()}
        onOpenChange={vi.fn()}
        onSubmit={onSubmit}
        open
      />,
    );

    const name = screen.getByRole("textbox", { name: "Nome" });
    await user.click(name);
    await user.keyboard("{Enter}");
    expect(screen.getByRole("alert")).toHaveTextContent("Informe um nome");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("keeps agent defaults and does not allow unavailable profiles", async () => {
    const user = userEvent.setup();
    const onChoose = vi.fn();
    const onSaveDefaultChange = vi.fn();
    render(
      <AgentPickerDialog
        agents={agents}
        onChoose={onChoose}
        onOpenChange={vi.fn()}
        onSaveDefaultChange={onSaveDefaultChange}
        open
        saveDefault={false}
      />,
    );

    expect(screen.getByRole("button", { name: /Claude.*indisponível/ })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Codex" }));
    await user.click(screen.getByRole("checkbox"));
    expect(onChoose).toHaveBeenCalledWith("codex");
    expect(onSaveDefaultChange).toHaveBeenCalledWith(true);
  });

  it("makes the current default and update option explicit in the picker", () => {
    render(
      <AgentPickerDialog
        agents={agents}
        defaultAgent="codex"
        onChoose={vi.fn()}
        onOpenChange={vi.fn()}
        onSaveDefaultChange={vi.fn()}
        open
        saveDefault
      />,
    );

    expect(document.body).toHaveTextContent(/Perfil padrão atual:\s*codex/);
    expect(screen.getByText("Definir a escolha como perfil padrão para os próximos agentes.")).toBeInTheDocument();
    expect(screen.getByRole("checkbox")).toBeChecked();
  });

  it("submits a controlled rename with the edited value", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <RenameDialog
        kind="group"
        onChange={vi.fn()}
        onOpenChange={vi.fn()}
        onSubmit={onSubmit}
        open
        value="Agents"
      />,
    );

    const input = screen.getByRole("textbox", { name: "Nome" });
    await user.clear(input);
    await user.type(input, "Agents core");
    await user.keyboard("{Enter}");
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("does not discard a resume item until explicit confirmation", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    const onDismissAll = vi.fn();
    const onDefer = vi.fn();
    render(
      <ResumeDialog
        items={[resumeItem]}
        onDefer={onDefer}
        onDismiss={onDismiss}
        onDismissAll={onDismissAll}
        onResume={vi.fn()}
        onResumeAll={vi.fn()}
        savedAt={Date.now() - 1_000}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Descartar todas" }));
    expect(onDismissAll).not.toHaveBeenCalled();
    const confirm = screen.getByRole("dialog", { name: "Descartar todas as sessões?" });
    expect(confirm).toBeInTheDocument();
    await user.click(within(confirm).getByRole("button", { name: "Descartar todas" }));
    expect(onDismissAll).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Começar do zero" }));
    expect(onDefer).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("resumes only the checked sessions, grouped by project", async () => {
    const user = userEvent.setup();
    const onResume = vi.fn();
    const onResumeAll = vi.fn();
    const second = { ...resumeItem, terminalId: "term-2", agentId: "claude", command: "claude", resumeCommand: "claude --continue" };
    render(
      <ResumeDialog
        items={[resumeItem, second]}
        onDefer={vi.fn()}
        onDismiss={vi.fn()}
        onDismissAll={vi.fn()}
        onResume={onResume}
        onResumeAll={onResumeAll}
        savedAt={null}
      />,
    );
    expect(screen.getByRole("button", { name: "Retomar 2 agentes" })).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: /claude --continue/ }));
    await user.click(screen.getByRole("button", { name: "Retomar 1 agente" }));
    expect(onResume).toHaveBeenCalledTimes(1);
    expect(onResume).toHaveBeenCalledWith(resumeItem);
    expect(onResumeAll).not.toHaveBeenCalled();
  });
});
