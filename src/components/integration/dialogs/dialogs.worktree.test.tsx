// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentInfo } from "../../../domain/agent.model";
import type { WorktreeStatus } from "../../../domain/worktree.model";
import { useLocaleStore } from "../../../i18n";
import { AgentPickerDialog } from "./AgentPickerDialog";
import { WorktreeCloseDialog } from "./WorktreeCloseDialog";

const LISTED_DIRTY_FILES = 20;
const DIRTY_FILE_COUNT = 22;

const dirtyFiles = Array.from(Array(DIRTY_FILE_COUNT).keys()).map((fileIndex) => `src/file-${fileIndex}.ts`);

const status: WorktreeStatus = {
  branch: "terra/feature-login",
  base: "main",
  path: "/tmp/terra-worktrees/feature-login",
  dirty: dirtyFiles,
  ahead: 2,
  behind: 0,
  isPresent: true,
};

function renderClose(target: { label: string; status: WorktreeStatus } | null, onReview?: () => void) {
  const handlers = { onKeep: vi.fn(), onDelete: vi.fn(), onCancel: vi.fn() };
  render(<WorktreeCloseDialog target={target} onReview={onReview} {...handlers} />);
  return handlers;
}

beforeEach(() => {
  useLocaleStore.setState({ locale: "en" });
});

describe("WorktreeCloseDialog", () => {
  it("Given a worktree with changes and commits, when the dialog opens, then it lists the facts and caps the file list", () => {
    renderClose({ label: "codex", status });

    expect(screen.getByRole("dialog", { name: "Close codex?" })).toHaveTextContent("on the branch terra/feature-login");
    expect(screen.getByText("22 files have changes that were not committed:")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(LISTED_DIRTY_FILES);
    expect(screen.getByText("2 commits are not in main yet.")).toBeInTheDocument();
  });

  it("Given a clean worktree, when the dialog opens, then it shows no facts and no review action", () => {
    renderClose({ label: "codex", status: { ...status, dirty: [], ahead: 0 } });

    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    expect(screen.queryByText(/commits? (is|are) not in/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Review changes" })).not.toBeInTheDocument();
  });

  it("Given the open dialog, when deleting with the branch checked, then the branch is deleted too", async () => {
    const user = userEvent.setup();
    const handlers = renderClose({ label: "codex", status });

    await user.click(screen.getByRole("checkbox", { name: "Also delete the branch terra/feature-login and its commits" }));
    await user.click(screen.getByRole("button", { name: "Delete the worktree" }));

    expect(handlers.onDelete).toHaveBeenCalledWith(true);
  });

  it("Given the open dialog, when keeping, reviewing or cancelling, then each handler runs", async () => {
    const user = userEvent.setup();
    const onReview = vi.fn();
    const handlers = renderClose({ label: "codex", status }, onReview);

    await user.click(screen.getByRole("button", { name: "Keep the worktree" }));
    await user.click(screen.getByRole("button", { name: "Review changes" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.keyboard("{Escape}");

    expect(handlers.onKeep).toHaveBeenCalledTimes(1);
    expect(onReview).toHaveBeenCalledTimes(1);
    expect(handlers.onCancel).toHaveBeenCalled();
    expect(handlers.onDelete).not.toHaveBeenCalled();
  });

  it("Given no target, when rendering, then the dialog stays closed", () => {
    renderClose(null);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("AgentPickerDialog options", () => {
  const agents: AgentInfo[] = [{ id: "codex", label: "Codex", isAvailable: true }];

  it("Given no detected agent, when the picker opens, then it says none was found and cancel closes it", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<AgentPickerDialog agents={[]} isOpen onChoose={vi.fn()} onOpenChange={onOpenChange} onSaveDefaultChange={vi.fn()} shouldSaveDefault={false} />);

    expect(screen.getByText("No agent detected yet.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("Given isolation and roles, when changing them, then the new choices are reported", async () => {
    const user = userEvent.setup();
    const onIsolateChange = vi.fn();
    const onRoleChange = vi.fn();
    const { rerender } = render(
      <AgentPickerDialog agents={agents} canIsolate isOpen onChoose={vi.fn()} onIsolateChange={onIsolateChange} onOpenChange={vi.fn()} onRoleChange={onRoleChange} onSaveDefaultChange={vi.fn()} shouldSaveDefault={false} />,
    );

    await user.click(screen.getByRole("checkbox", { name: /Isolate in a git worktree/ }));
    expect(onIsolateChange).toHaveBeenCalledWith(true);
    await user.selectOptions(screen.getByRole("combobox", { name: "Team role" }), "Executor");
    expect(onRoleChange).toHaveBeenCalledWith("executor");

    rerender(
      <AgentPickerDialog agents={agents} canIsolate isOpen onChoose={vi.fn()} onIsolateChange={onIsolateChange} onOpenChange={vi.fn()} onRoleChange={onRoleChange} onSaveDefaultChange={vi.fn()} role="executor" shouldIsolate shouldSaveDefault={false} />,
    );
    expect(screen.getByRole("checkbox", { name: /Isolate in a git worktree/ })).toBeChecked();
    await user.selectOptions(screen.getByRole("combobox", { name: "Team role" }), "No role");
    expect(onRoleChange).toHaveBeenLastCalledWith(null);
  });

  it("Given isolation without a change handler, when the picker opens, then it offers neither isolation nor roles", () => {
    render(<AgentPickerDialog agents={agents} canIsolate isOpen onChoose={vi.fn()} onOpenChange={vi.fn()} onSaveDefaultChange={vi.fn()} shouldSaveDefault={false} />);

    expect(screen.queryByRole("checkbox", { name: /Isolate/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });
});
