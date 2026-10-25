// @vitest-environment jsdom

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace, WorkspaceGroup } from "../../domain/workspace.model";
import { deriveSnapshot } from "../../domain/workspaceProjection";
import { useLocaleStore } from "../../i18n";
import { NavigatorPanel } from "./NavigatorPanel";

const groups: WorkspaceGroup[] = [
  { id: "group-core", name: "Core", isCollapsed: false, projectIds: ["ws-api"], parentGroupId: null, isSuspended: false },
  { id: "group-lab", name: "Lab", isCollapsed: false, projectIds: ["ws-lab"], parentGroupId: null, isSuspended: true },
];

const workspaces: Workspace[] = [
  { id: "ws-api", name: "Terra API", cwd: "/tmp/terra-api", groupId: "group-core", terminals: [{ id: "term-codex", command: "codex", width: 100 }] },
  { id: "ws-lab", name: "Terra Lab", cwd: "/tmp/terra-lab", groupId: "group-lab", terminals: [{ id: "term-lab", command: "claude", width: 100 }] },
  { id: "ws-web", name: "Terra Web", cwd: "/tmp/terra-web", terminals: [] },
];

beforeEach(() => {
  useLocaleStore.setState({ locale: "en" });
});

function row(name: string): HTMLElement {
  return screen.getByRole("treeitem", { name });
}

describe("Navigator rows", () => {
  it("Given groups and projects, when creating and renaming from their rows, then the matching node is passed on", async () => {
    const user = userEvent.setup();
    const onCreateProject = vi.fn();
    const onCreateAgent = vi.fn();
    const onRenameNode = vi.fn();
    render(<NavigatorPanel workspaces={workspaces} groups={groups} onCreateProject={onCreateProject} onCreateAgent={onCreateAgent} onRenameNode={onRenameNode} />);

    await user.click(within(row("Group Core")).getByRole("button", { name: "Create inside" }));
    expect(onCreateProject).toHaveBeenCalledWith("group-core");
    await user.click(within(row("Project Terra API")).getByRole("button", { name: "Create inside" }));
    expect(onCreateAgent).toHaveBeenCalledWith("ws-api");
    await user.click(within(row("Project Terra API")).getByRole("button", { name: "Rename" }));
    expect(onRenameNode).toHaveBeenCalledWith(expect.objectContaining({ kind: "project", id: "ws-api" }));
    expect(screen.getByText("Ungrouped")).toBeInTheDocument();
  });

  it("Given a running and a suspended group, when using their row actions, then they are suspended or resumed", async () => {
    const user = userEvent.setup();
    const onSuspendGroup = vi.fn();
    const onResumeGroup = vi.fn();
    render(<NavigatorPanel workspaces={workspaces} groups={groups} onSuspendGroup={onSuspendGroup} onResumeGroup={onResumeGroup} />);

    await user.click(within(row("Group Core")).getByRole("button", { name: "Suspend group" }));
    await user.click(within(row("Group Lab")).getByRole("button", { name: "Resume group" }));

    expect(onSuspendGroup).toHaveBeenCalledWith("group-core");
    expect(onResumeGroup).toHaveBeenCalledWith("group-lab");
  });

  it("Given an agent and a project, when opening the agent and deleting the project, then the terminal is focused and the project removed", async () => {
    const user = userEvent.setup();
    const onOpenTerminal = vi.fn();
    const onFocus = vi.fn();
    const onDeleteWorkspace = vi.fn();
    render(<NavigatorPanel workspaces={workspaces} groups={groups} onOpenTerminal={onOpenTerminal} onFocus={onFocus} onDeleteWorkspace={onDeleteWorkspace} />);

    await user.click(row("Agent codex"));
    await user.click(within(row("Project Terra API")).getByRole("button", { name: "Delete project" }));

    expect(onOpenTerminal).toHaveBeenCalledWith("ws-api", "term-codex");
    expect(onFocus).toHaveBeenCalledWith("term-codex");
    expect(onDeleteWorkspace).toHaveBeenCalledWith("ws-api");
  });

  it("Given a visible and a hidden project, when toggling them, then the hide handler runs for each", async () => {
    const user = userEvent.setup();
    const onHideWorkspace = vi.fn();
    const onHideContainer = vi.fn();
    render(<NavigatorPanel workspaces={workspaces} groups={groups} containerVisibility={{ "ws-web": false }} onHideWorkspace={onHideWorkspace} onHideContainer={onHideContainer} />);

    await user.click(within(row("Project Terra API")).getByRole("button", { name: "Hide project" }));
    const hidden = row("Project Terra Web");
    expect(within(hidden).getByLabelText("Hidden")).toBeInTheDocument();
    await user.click(within(hidden).getByRole("button", { name: "Show project" }));

    expect(onHideContainer).toHaveBeenCalledWith("ws-api");
    expect(onHideContainer).toHaveBeenCalledWith("ws-web");
    expect(onHideWorkspace).not.toHaveBeenCalled();
  });

  it("Given a group row, when using the keyboard, then arrows and Enter fold and unfold it", async () => {
    const user = userEvent.setup();
    render(<NavigatorPanel workspaces={workspaces} groups={groups} />);
    const group = row("Group Core");

    group.focus();
    await user.keyboard("{ArrowRight}");
    expect(group).toHaveAttribute("aria-expanded", "true");
    await user.keyboard("{ArrowLeft}");
    expect(group).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("treeitem", { name: "Project Terra API" })).not.toBeInTheDocument();
    await user.keyboard("{ArrowLeft}");
    expect(group).toHaveAttribute("aria-expanded", "false");
    await user.keyboard(" ");
    expect(group).toHaveAttribute("aria-expanded", "true");
    await user.keyboard("{Enter}");
    expect(group).toHaveAttribute("aria-expanded", "false");
  });

  it("Given a project row, when pressing Space or using its disclosure, then it opens or folds", async () => {
    const user = userEvent.setup();
    const onOpenWorkspace = vi.fn();
    render(<NavigatorPanel workspaces={workspaces} groups={groups} onOpenWorkspace={onOpenWorkspace} />);
    const project = row("Project Terra API");

    project.focus();
    await user.keyboard(" ");
    expect(onOpenWorkspace).toHaveBeenCalledWith("ws-api");

    await user.click(within(project).getByRole("button", { name: "Collapse" }));
    expect(project).toHaveAttribute("aria-expanded", "false");
    await user.click(within(project).getByRole("button", { name: "Expand" }));
    expect(project).toHaveAttribute("aria-expanded", "true");
    expect(onOpenWorkspace).toHaveBeenCalledTimes(1);
  });

  it("Given a key pressed on a row action, when it bubbles to the row, then the row ignores it", async () => {
    const user = userEvent.setup();
    const onOpenWorkspace = vi.fn();
    render(<NavigatorPanel workspaces={workspaces} groups={groups} onOpenWorkspace={onOpenWorkspace} onRenameNode={vi.fn()} />);

    within(row("Project Terra API")).getByRole("button", { name: "Rename" }).focus();
    await user.keyboard("{ArrowLeft}");

    expect(row("Project Terra API")).toHaveAttribute("aria-expanded", "true");
  });

  it("Given an agent with notifications and a nearly full context, when it renders, then its badges show", () => {
    render(<NavigatorPanel workspaces={workspaces} groups={groups} notifications={{ "term-codex": 3 }} contextUsage={{ "term-codex": 91, "term-lab": 40 }} shouldFlatten />);

    const agent = row("Agent codex");
    expect(within(agent).getByText("3")).toBeInTheDocument();
    expect(within(agent).getByTitle("Context")).toHaveTextContent("91%");
    expect(within(row("Agent claude")).getByTitle("Context")).toHaveTextContent("40%");
  });

  it("Given a structural snapshot, when opening a container and a pane, then their project opens", async () => {
    const user = userEvent.setup();
    const onOpenWorkspace = vi.fn();
    const { snapshot } = deriveSnapshot({ workspaces: [workspaces[0]], groups: [groups[0]] }, {}, null);
    render(<NavigatorPanel workspaces={[workspaces[0]]} groups={[groups[0]]} snapshot={snapshot} onOpenWorkspace={onOpenWorkspace} />);

    await user.click(screen.getByRole("treeitem", { name: /^Container / }));
    await user.click(screen.getByRole("treeitem", { name: /^Pane / }));

    expect(onOpenWorkspace).toHaveBeenNthCalledWith(1, "ws-api");
    expect(onOpenWorkspace).toHaveBeenNthCalledWith(2, "ws-api");
  });

  it("Given a search that matches nothing, when typing it, then the tree says no project was found", async () => {
    const user = userEvent.setup();
    render(<NavigatorPanel workspaces={workspaces} groups={groups} />);

    await user.type(screen.getByRole("searchbox", { name: "Search projects and agents" }), "zzz");

    expect(screen.getByText("No project found")).toBeInTheDocument();
  });
});
