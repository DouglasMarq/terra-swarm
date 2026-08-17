// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FleetCommandCenter } from "./FleetCommandCenter";
import type { Workspace, WorkspaceGroup } from "../../types";

const groups: WorkspaceGroup[] = [{
  id: "group-core",
  name: "Core",
  collapsed: false,
  projectIds: ["ws-api"],
  parentGroupId: null,
  suspended: false,
}];

const workspaces: Workspace[] = [{
  id: "ws-api",
  name: "Terra API",
  cwd: "/tmp/terra-api",
  groupId: "group-core",
  terminals: [
    { id: "term-codex", command: "codex", width: 100 },
    { id: "term-luna", command: "luna-max", width: 100, suspended: true },
  ],
}];

describe("FleetCommandCenter", () => {
  it("renders fleet telemetry and forwards focus/voice actions", async () => {
    const user = userEvent.setup();
    const onFocus = vi.fn();
    const onVoice = vi.fn();
    render(<FleetCommandCenter agentLabels={{ "term-luna": "Luna Max" }} groups={groups} onFocus={onFocus} onVoice={onVoice} workspaces={workspaces} />);

    expect(screen.getByRole("heading", { name: "Fleet command center" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Core" })).toBeInTheDocument();
    expect(screen.getAllByText("Codex").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Suspended").length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: "Focus Codex in Terra API" }));
    const voiceButtons = screen.getAllByRole("button", { name: "Send voice command to agent" });
    await user.click(voiceButtons[0]!);
    expect(onFocus).toHaveBeenCalledWith("term-codex", "ws-api");
    expect(onVoice).toHaveBeenCalledWith("term-codex");
  });

  it("filters agents without losing the source fleet", async () => {
    const user = userEvent.setup();
    render(<FleetCommandCenter agentLabels={{ "term-luna": "Luna Max" }} groups={groups} workspaces={workspaces} />);
    const search = screen.getByRole("searchbox", { name: "Search fleet" });
    await user.type(search, "luna");
    expect(screen.getAllByText("Luna Max").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Focus Codex in Terra API" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset" })).toBeEnabled();
  });

  it("routes individual and batch lifecycle actions without exposing dead controls", async () => {
    const user = userEvent.setup();
    const onResume = vi.fn();
    const onStop = vi.fn();
    const onBatchAction = vi.fn();
    render(<FleetCommandCenter groups={groups} onBatchAction={onBatchAction} onResume={onResume} onStop={onStop} workspaces={workspaces} />);

    await user.click(screen.getByRole("button", { name: "Resume agent" }));
    const stopButtons = screen.getAllByRole("button", { name: "Stop agent (preserve session)" });
    await user.click(stopButtons[0]!);
    expect(onResume).toHaveBeenCalledWith("term-luna");
    expect(onStop).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Parar sessão" }));
    expect(onStop).toHaveBeenCalledWith("term-codex");

    await user.click(screen.getByRole("checkbox", { name: "Select Codex in Terra API" }));
    await user.click(screen.getByRole("button", { name: "Stop (preserve session)" }));
    expect(onBatchAction).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Parar sessão" }));
    expect(onBatchAction).toHaveBeenCalledWith("stop", ["term-codex"]);
  });

  it("confirms the real group suspension path and never exposes terminal suspend", async () => {
    const user = userEvent.setup();
    const onSuspendGroup = vi.fn();
    render(<FleetCommandCenter groups={groups} onSuspendGroup={onSuspendGroup} workspaces={workspaces} />);

    await user.click(screen.getByRole("button", { name: "Suspend group" }));
    expect(onSuspendGroup).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Suspender grupo" }));
    expect(onSuspendGroup).toHaveBeenCalledWith("group-core");
    expect(screen.queryByRole("button", { name: "Suspend agent" })).not.toBeInTheDocument();
  });

  it("does not render action affordances when the host has no callback", () => {
    render(<FleetCommandCenter groups={groups} workspaces={workspaces} />);

    expect(screen.queryByRole("button", { name: "Focus Codex in Terra API" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Suspend agent" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop agent (preserve session)" })).not.toBeInTheDocument();
  });
});
