// @vitest-environment jsdom

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const pty = vi.hoisted(() => ({ writeTerminal: vi.fn() }));

vi.mock("../../lib/tauri/pty", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/tauri/pty")>()),
  writeTerminal: pty.writeTerminal,
}));

import { useLocaleStore } from "../../i18n";
import { useLibraryStore } from "../../stores/libraryStore";
import { PromptLibraryDialog } from "./PromptLibraryDialog";
import { TeamDialog, type TeamDialogProps } from "./TeamDialog";

const prompts = [
  { id: "review", title: "Review my changes", body: "Review {project} carefully." },
  { id: "tests", title: "Write tests", body: "Add tests for the last change." },
];

const targets = [
  { id: "t-1", label: "claude 1" },
  { id: "t-2", label: "codex 1" },
];

beforeEach(() => {
  useLocaleStore.setState({ locale: "en" });
  localStorage.clear();
  useLibraryStore.setState({ prompts, dialog: null });
  pty.writeTerminal.mockReset().mockResolvedValue(undefined);
});

function openPrompts(overrides: Partial<Parameters<typeof PromptLibraryDialog>[0]> = {}) {
  useLibraryStore.setState({ dialog: "prompts" });
  return render(<PromptLibraryDialog projectName="terra" targets={targets} defaultTargetId="t-2" {...overrides} />);
}

describe("PromptLibraryDialog", () => {
  it("Given saved prompts, when the library opens, then the first prompt is loaded for the default target", () => {
    openPrompts();

    expect(screen.getByRole("dialog", { name: "Prompt library" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("Review my changes");
    expect(screen.getByRole("textbox", { name: "Prompt" })).toHaveValue("Review {project} carefully.");
    expect(screen.getByRole("combobox", { name: "Send to" })).toHaveValue("t-2");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("Given the library, when searching, then only matching prompts are listed", async () => {
    const user = userEvent.setup();
    openPrompts();

    await user.type(screen.getByRole("textbox", { name: "Search prompts" }), "last change");

    expect(screen.getByRole("button", { name: "Write tests" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Review my changes" })).not.toBeInTheDocument();
  });

  it("Given a selected prompt, when editing and saving it, then the store keeps the new text", async () => {
    const user = userEvent.setup();
    openPrompts();

    await user.click(screen.getByRole("button", { name: "Write tests" }));
    const body = screen.getByRole("textbox", { name: "Prompt" });
    expect(body).toHaveValue("Add tests for the last change.");
    await user.type(body, " Run them.");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(screen.getByRole("status")).toHaveTextContent("Saved.");
    expect(useLibraryStore.getState().prompts.find((prompt) => prompt.id === "tests")?.body).toBe("Add tests for the last change. Run them.");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("Given a new prompt without a title, when saving, then it is added with a derived title", async () => {
    const user = userEvent.setup();
    openPrompts();

    await user.click(screen.getByRole("button", { name: "New prompt" }));
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("");
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "Prompt" }), "Refactor the router module");
    await user.click(screen.getByRole("button", { name: "Save" }));

    const added = useLibraryStore.getState().prompts.at(-1);
    expect(added?.body).toBe("Refactor the router module");
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue(added?.title);
    expect(screen.getByRole("button", { name: added?.title })).toBeInTheDocument();
  });

  it("Given a selected prompt, when deleting it, then it leaves the list and the editor clears", async () => {
    const user = userEvent.setup();
    openPrompts();

    await user.click(screen.getByRole("button", { name: "Delete" }));

    expect(useLibraryStore.getState().prompts.map((prompt) => prompt.id)).toEqual(["tests"]);
    expect(screen.queryByRole("button", { name: "Review my changes" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Prompt" })).toHaveValue("");
  });

  it("Given a target agent, when sending, then the prompt is filled with the project and typed into its terminal", async () => {
    const user = userEvent.setup();
    openPrompts();

    await user.selectOptions(screen.getByRole("combobox", { name: "Send to" }), "t-1");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Sent to claude 1.");
    expect(pty.writeTerminal).toHaveBeenCalledWith("t-1", "\u001b[200~Review terra carefully.\u001b[201~");
    expect(pty.writeTerminal).toHaveBeenCalledWith("t-1", "\r");
  });

  it("Given the terminal write fails, when sending, then the failure is shown", async () => {
    const user = userEvent.setup();
    pty.writeTerminal.mockRejectedValue(new Error("pty closed"));
    openPrompts();

    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Could not send to codex 1.");
  });

  it("Given no running agent and no prompt, when the library opens, then sending is impossible", () => {
    useLibraryStore.setState({ prompts: [] });
    openPrompts({ targets: [], defaultTargetId: null });

    const target = screen.getByRole("combobox", { name: "Send to" });
    expect(target).toBeDisabled();
    expect(within(target).getByRole("option", { name: "No running agent" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("Given no default target, when the library opens, then the first agent is picked", () => {
    openPrompts({ defaultTargetId: null });

    expect(screen.getByRole("combobox", { name: "Send to" })).toHaveValue("t-1");
  });

  it("Given the library is open, when closing it, then the store dialog clears", async () => {
    const user = userEvent.setup();
    openPrompts();

    await user.keyboard("{Escape}");

    expect(useLibraryStore.getState().dialog).toBeNull();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});

const installed = [
  { id: "claude", label: "Claude Code", isAvailable: true },
  { id: "codex", label: "Codex", isAvailable: false },
];

function openTeam(overrides: Partial<TeamDialogProps> = {}) {
  useLibraryStore.setState({ dialog: "team" });
  const onSpawn = vi.fn<TeamDialogProps["onSpawn"]>().mockResolvedValue(undefined);
  render(<TeamDialog projectName="terra" agents={installed} defaultAgent="claude" canIsolate onSpawn={onSpawn} {...overrides} />);
  return { onSpawn };
}

describe("TeamDialog", () => {
  it("Given the feature team, when starting it, then every member spawns with its role and worktree and the dialog closes", async () => {
    const user = userEvent.setup();
    const { onSpawn } = openTeam();

    expect(screen.getByRole("dialog", { name: "Start a team in terra" })).toBeInTheDocument();
    const members = screen.getByRole("list", { name: "Members" });
    expect(within(members).getAllByRole("listitem")).toHaveLength(5);
    expect(within(members).getAllByText("stand-in agent")).toHaveLength(1);
    expect(within(members).getAllByText("own worktree")).toHaveLength(3);

    await user.click(screen.getByRole("button", { name: "Start 5 agents" }));

    expect(onSpawn).toHaveBeenCalledTimes(5);
    expect(onSpawn).toHaveBeenNthCalledWith(1, "claude", { role: "orchestrator", shouldUseWorktree: false });
    expect(onSpawn).toHaveBeenNthCalledWith(3, "claude", { role: "executor", shouldUseWorktree: true });
    await waitFor(() => expect(useLibraryStore.getState().dialog).toBeNull());
  });

  it("Given another template without isolation, when picking it, then the plan follows and no worktree is used", async () => {
    const user = userEvent.setup();
    const { onSpawn } = openTeam({ canIsolate: false });

    await user.click(screen.getByRole("radio", { name: /Review and test/ }));
    expect(screen.queryByText("own worktree")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Start 2 agents" }));

    expect(onSpawn).toHaveBeenNthCalledWith(1, "claude", { role: "reviewer", shouldUseWorktree: false });
    expect(onSpawn).toHaveBeenNthCalledWith(2, "claude", { role: "tester", shouldUseWorktree: false });
  });

  it("Given a spawn that fails, when starting, then the error shows and the dialog stays open", async () => {
    const user = userEvent.setup();
    const onSpawn = vi.fn<TeamDialogProps["onSpawn"]>().mockRejectedValue(new Error("spawn failed"));
    openTeam({ onSpawn });

    await user.click(screen.getByRole("radio", { name: /Orchestrator and executor/ }));
    await user.click(screen.getByRole("button", { name: "Start 2 agents" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("spawn failed");
    expect(useLibraryStore.getState().dialog).toBe("team");
    expect(screen.getByRole("button", { name: "Start 2 agents" })).toBeEnabled();
  });

  it("Given a team that is starting, when trying to close, then the dialog waits", async () => {
    const user = userEvent.setup();
    let finish: () => void = () => undefined;
    const onSpawn = vi.fn<TeamDialogProps["onSpawn"]>(() => new Promise<void>((resolve) => { finish = resolve; }));
    openTeam({ onSpawn });

    await user.click(screen.getByRole("button", { name: "Start 5 agents" }));
    expect(screen.getByRole("button", { name: "Starting…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(useLibraryStore.getState().dialog).toBe("team");

    finish();
    await waitFor(() => expect(onSpawn).toHaveBeenCalledTimes(2));
  });

  it("Given no installed coding agent, when the dialog opens, then starting is blocked", () => {
    openTeam({ agents: [{ id: "shell", label: "Shell", isAvailable: true }], projectName: null });

    expect(screen.getByRole("alert")).toHaveTextContent("No coding agent is installed.");
    expect(screen.queryByRole("list", { name: "Members" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start 0 agents" })).toBeDisabled();
  });

  it("Given the team dialog, when cancelling, then the store dialog clears", async () => {
    const user = userEvent.setup();
    openTeam();

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(useLibraryStore.getState().dialog).toBeNull();
  });
});
