import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { resizeTerminal, spawnTerminal } from "./pty";
import { moveWorkspacePane, writeWorkspaceFile } from "./workspace";
import { worktreeApi } from "./worktree";

describe("commands that take one request", () => {
  beforeEach(() => {
    invoke.mockReset().mockResolvedValue(undefined);
  });

  it("Given a spawn without size, shell or launch extras, when spawning, then one request with the defaults is sent", async () => {
    await spawnTerminal({ workspaceId: "ws-1", command: "codex" });

    expect(invoke).toHaveBeenCalledWith("spawn_terminal", {
      request: {
        workspaceId: "ws-1",
        command: "codex",
        cols: 80,
        rows: 24,
        terminalId: null,
        shell: null,
        launch: null,
      },
    });
  });

  it("Given a respawn with its size and worktree, when spawning, then the request carries them", async () => {
    await spawnTerminal({
      workspaceId: "ws-1",
      command: "claude",
      terminalId: "pty-1",
      cols: 120,
      rows: 40,
      shell: "/bin/zsh",
      launch: { shouldUseWorktree: true },
    });

    expect(invoke).toHaveBeenCalledWith("spawn_terminal", {
      request: {
        workspaceId: "ws-1",
        command: "claude",
        cols: 120,
        rows: 40,
        terminalId: "pty-1",
        shell: "/bin/zsh",
        launch: { shouldUseWorktree: true },
      },
    });
  });

  it("Given a pane move without an index, when moving, then the request leaves the index out", async () => {
    await moveWorkspacePane({ workspaceId: "ws-1", paneId: "pane-1", toContainerId: "container-2" });
    await moveWorkspacePane({ workspaceId: "ws-1", paneId: "pane-1", toContainerId: "container-2", index: 0 });

    expect(invoke).toHaveBeenNthCalledWith(1, "move_workspace_pane", {
      request: { workspaceId: "ws-1", paneId: "pane-1", toContainerId: "container-2" },
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "move_workspace_pane", {
      request: { workspaceId: "ws-1", paneId: "pane-1", toContainerId: "container-2", index: 0 },
    });
  });

  it("Given a file save, a pull request and a resize, when sending them, then each goes as one request", async () => {
    const write = { workspaceId: "ws-1", relativePath: "src/a.ts", content: "one", expectedModified: null };
    const pullRequest = { workspaceId: "ws-1", terminalId: "pty-1", title: "Changes", body: "" };

    await writeWorkspaceFile(write);
    await worktreeApi.worktreeOpenPr(pullRequest);
    await resizeTerminal("pty-1", 100, 30);

    expect(invoke).toHaveBeenCalledWith("write_workspace_file", { request: write });
    expect(invoke).toHaveBeenCalledWith("worktree_open_pr", { request: pullRequest });
    expect(invoke).toHaveBeenCalledWith("resize_terminal", { request: { id: "pty-1", cols: 100, rows: 30 } });
  });
});
