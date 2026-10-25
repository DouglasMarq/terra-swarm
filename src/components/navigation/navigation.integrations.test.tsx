// @vitest-environment jsdom

import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace, WorkspaceGitStatus } from "../../domain/workspace.model";
import type { WorkspaceFileListing } from "../../domain/workspaceFiles.model";
import { useLocaleStore } from "../../i18n";
import { NavigatorFilesView } from "./NavigatorFilesView";
import { NavigatorGitView } from "./NavigatorGitView";

const LIST_LIMIT = 200;

const workspaces: Workspace[] = [
  { id: "ws-api", name: "Terra API", cwd: "/tmp/terra-api", terminals: [] },
  { id: "ws-web", name: "Terra Web", cwd: "/tmp/terra-web", terminals: [] },
];

const rootListing: WorkspaceFileListing = {
  path: "",
  isTruncated: true,
  limit: LIST_LIMIT,
  entries: [
    { name: "src", path: "src", kind: "directory", size: null },
    { name: "README.md", path: "README.md", kind: "file", size: 12 },
    { name: "notes", path: "notes", kind: "file", size: null },
    { name: "latest", path: "latest", kind: "symlink", size: null },
  ],
};

const emptyListing: WorkspaceFileListing = { path: "src", isTruncated: false, limit: LIST_LIMIT, entries: [] };

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function gitStatus(overrides: Partial<WorkspaceGitStatus> = {}): WorkspaceGitStatus {
  return { branch: "main", ahead: 0, behind: 0, staged: [], modified: [], untracked: [], conflicted: [], ...overrides };
}

beforeEach(() => {
  useLocaleStore.setState({ locale: "en" });
});

describe("NavigatorFilesView", () => {
  it("Given no project, when the view renders, then it asks for one and reports the selection", async () => {
    const user = userEvent.setup();
    const onSelectWorkspace = vi.fn();
    const loadFiles = vi.fn();
    render(<NavigatorFilesView workspaces={workspaces} loadFiles={loadFiles} onSelectWorkspace={onSelectWorkspace} />);

    expect(screen.getByText("Pick a project to browse its files.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh files" })).toBeDisabled();
    await user.selectOptions(screen.getByRole("combobox", { name: "Files project" }), "Terra Web");

    expect(onSelectWorkspace).toHaveBeenCalledWith("ws-web");
    expect(loadFiles).not.toHaveBeenCalled();
  });

  it("Given a listed project, when browsing it, then files open, folders unfold once and the limit is noted", async () => {
    const user = userEvent.setup();
    const onOpenFile = vi.fn();
    const loadFiles = vi.fn((_workspaceId: string, relativePath: string) => Promise.resolve(relativePath === "" ? rootListing : emptyListing));
    render(<NavigatorFilesView workspaces={workspaces} activeWorkspaceId="ws-api" loadFiles={loadFiles} onOpenFile={onOpenFile} />);

    await user.click(await screen.findByRole("button", { name: "Open README.md" }));
    expect(onOpenFile).toHaveBeenCalledWith("ws-api", "README.md");
    expect(screen.getByText("12 B")).toBeInTheDocument();
    expect(screen.getByText("List limited to 200 items.")).toBeInTheDocument();

    const folder = screen.getByRole("button", { name: "src" });
    await user.click(folder);
    expect(await screen.findByText("No files in this folder.")).toBeInTheDocument();
    expect(folder).toHaveAttribute("aria-expanded", "true");
    await user.click(folder);
    expect(screen.queryByText("No files in this folder.")).not.toBeInTheDocument();
    await user.click(folder);

    expect(loadFiles).toHaveBeenCalledTimes(2);
    expect(loadFiles).toHaveBeenCalledWith("ws-api", "src", LIST_LIMIT);
  });

  it("Given no open handler, when files are listed, then they are static rows", async () => {
    render(<NavigatorFilesView workspaces={workspaces} activeWorkspaceId="ws-api" loadFiles={() => Promise.resolve(rootListing)} />);

    expect(await screen.findByRole("listitem", { name: "File README.md" })).toBeInTheDocument();
    expect(screen.getByRole("listitem", { name: "File latest" })).toBeInTheDocument();
  });

  it("Given a folder still loading, when it unfolds, then the row and the folder show progress", async () => {
    const user = userEvent.setup();
    const pending = deferred<WorkspaceFileListing>();
    const loadFiles = vi.fn((_workspaceId: string, relativePath: string) => (relativePath === "" ? Promise.resolve(rootListing) : pending.promise));
    render(<NavigatorFilesView workspaces={workspaces} activeWorkspaceId="ws-api" loadFiles={loadFiles} />);

    await user.click(await screen.findByRole("button", { name: "src" }));

    expect(screen.getByLabelText("Loading")).toBeInTheDocument();
    expect(screen.getByText("Loading files…")).toBeInTheDocument();
    await act(async () => pending.resolve(emptyListing));
    expect(screen.getByText("No files in this folder.")).toBeInTheDocument();
  });

  it("Given a failing listing, when retrying, then the error clears and the files show", async () => {
    const user = userEvent.setup();
    const loadFiles = vi.fn().mockRejectedValueOnce(new Error("permission denied")).mockResolvedValueOnce(rootListing);
    render(<NavigatorFilesView workspaces={workspaces} activeWorkspaceId="ws-api" loadFiles={loadFiles} />);

    expect(await screen.findByText("permission denied")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("button", { name: "src" })).toBeInTheDocument();
  });

  it("Given a listing that fails on refresh without a message, when refreshing, then the old files stay with a generic notice", async () => {
    const user = userEvent.setup();
    const loadFiles = vi.fn().mockResolvedValueOnce(rootListing).mockRejectedValueOnce("");
    render(<NavigatorFilesView workspaces={workspaces} activeWorkspaceId="ws-api" loadFiles={loadFiles} />);

    await screen.findByRole("button", { name: "src" });
    await user.click(screen.getByRole("button", { name: "Refresh files" }));

    expect(await screen.findByText("Couldn't list this folder.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "src" })).toBeInTheDocument();
  });

  it("Given a first listing that fails without a message, when it renders, then a generic error is offered", async () => {
    render(<NavigatorFilesView workspaces={workspaces} activeWorkspaceId="ws-api" loadFiles={() => Promise.reject(new Error(" "))} />);

    expect(await screen.findByText("Couldn't list this folder.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("Given a listing still loading, when the project changes, then the stale answers are ignored", async () => {
    const stale = deferred<WorkspaceFileListing>();
    const staleFailure = deferred<WorkspaceFileListing>();
    const answers: Record<string, Promise<WorkspaceFileListing>> = { "ws-api": stale.promise, "ws-web": Promise.resolve(emptyListing) };
    const loadFiles = vi.fn((workspaceId: string) => answers[workspaceId]);
    const { rerender } = render(<NavigatorFilesView workspaces={workspaces} activeWorkspaceId="ws-api" loadFiles={loadFiles} />);

    rerender(<NavigatorFilesView workspaces={workspaces} activeWorkspaceId="ws-web" loadFiles={loadFiles} />);
    expect(await screen.findByText("No files in this folder.")).toBeInTheDocument();
    await act(async () => stale.resolve(rootListing));
    expect(screen.queryByRole("button", { name: "src" })).not.toBeInTheDocument();

    answers["ws-api"] = staleFailure.promise;
    rerender(<NavigatorFilesView workspaces={workspaces} activeWorkspaceId="ws-api" loadFiles={loadFiles} />);
    rerender(<NavigatorFilesView workspaces={workspaces} activeWorkspaceId="ws-web" loadFiles={loadFiles} />);
    await act(async () => staleFailure.reject(new Error("too late")));
    expect(screen.queryByText("too late")).not.toBeInTheDocument();
  });
});

describe("NavigatorGitView", () => {
  it("Given no project, when the view renders, then it asks for one and reports the selection", async () => {
    const user = userEvent.setup();
    const onSelectWorkspace = vi.fn();
    render(<NavigatorGitView workspaces={workspaces} loadGitStatus={vi.fn()} onSelectWorkspace={onSelectWorkspace} />);

    expect(screen.getByText("Pick a project to check its Git status.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh Git" })).toBeDisabled();
    await user.selectOptions(screen.getByRole("combobox", { name: "Git project" }), "Terra API");

    expect(onSelectWorkspace).toHaveBeenCalledWith("ws-api");
  });

  it("Given a detached repository with changes, when the status loads, then it lists every section and the divergence", async () => {
    const pending = deferred<WorkspaceGitStatus>();
    render(<NavigatorGitView workspaces={workspaces} activeWorkspaceId="ws-api" loadGitStatus={() => pending.promise} />);

    expect(screen.getByText("Checking Git…")).toBeInTheDocument();
    await act(async () =>
      pending.resolve(gitStatus({ branch: null, ahead: 2, behind: 1, staged: ["a.ts"], modified: ["b.ts"], untracked: ["c.ts"], conflicted: ["d.ts"] })),
    );

    expect(screen.getByText("Detached HEAD")).toBeInTheDocument();
    expect(screen.getByText("4 changes")).toBeInTheDocument();
    expect(screen.getByText("2 ahead · 1 behind")).toBeInTheDocument();
    expect(screen.getByText("Conflicts")).toBeInTheDocument();
    expect(screen.getByText("Untracked")).toBeInTheDocument();
    expect(screen.getByText("d.ts")).toBeInTheDocument();
  });

  it("Given a clean branch only ahead or only behind, when the status loads, then only that side is noted", async () => {
    const user = userEvent.setup();
    const loadGitStatus = vi.fn().mockResolvedValueOnce(gitStatus({ ahead: 1 })).mockResolvedValueOnce(gitStatus({ behind: 3 }));
    render(<NavigatorGitView workspaces={workspaces} activeWorkspaceId="ws-api" loadGitStatus={loadGitStatus} />);

    expect(await screen.findByText("1 ahead")).toBeInTheDocument();
    expect(screen.getByText("Working tree clean.")).toBeInTheDocument();
    expect(screen.getByText("main")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Refresh Git" }));

    expect(await screen.findByText("3 behind")).toBeInTheDocument();
  });

  it("Given a failing status, when retrying, then the error clears and the status shows", async () => {
    const user = userEvent.setup();
    const loadGitStatus = vi.fn().mockRejectedValueOnce(new Error("not a git repository")).mockRejectedValueOnce("").mockResolvedValueOnce(gitStatus());
    render(<NavigatorGitView workspaces={workspaces} activeWorkspaceId="ws-api" loadGitStatus={loadGitStatus} />);

    expect(await screen.findByText("not a git repository")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Couldn't read this project's Git status.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Working tree clean.")).toBeInTheDocument();
  });

  it("Given a status still loading, when the project changes or is cleared, then stale answers are ignored", async () => {
    const stale = deferred<WorkspaceGitStatus>();
    const staleFailure = deferred<WorkspaceGitStatus>();
    const answers: Record<string, Promise<WorkspaceGitStatus>> = { "ws-api": stale.promise, "ws-web": Promise.resolve(gitStatus({ branch: "develop" })) };
    const loadGitStatus = vi.fn((workspaceId: string) => answers[workspaceId]);
    const { rerender } = render(<NavigatorGitView workspaces={workspaces} activeWorkspaceId="ws-api" loadGitStatus={loadGitStatus} />);

    rerender(<NavigatorGitView workspaces={workspaces} activeWorkspaceId="ws-web" loadGitStatus={loadGitStatus} />);
    expect(await screen.findByText("develop")).toBeInTheDocument();
    await act(async () => stale.resolve(gitStatus({ branch: "stale-branch" })));
    expect(screen.queryByText("stale-branch")).not.toBeInTheDocument();

    answers["ws-api"] = staleFailure.promise;
    rerender(<NavigatorGitView workspaces={workspaces} activeWorkspaceId="ws-api" loadGitStatus={loadGitStatus} />);
    rerender(<NavigatorGitView workspaces={workspaces} activeWorkspaceId={null} loadGitStatus={loadGitStatus} />);
    await act(async () => staleFailure.reject(new Error("too late")));

    expect(screen.queryByText("too late")).not.toBeInTheDocument();
    expect(screen.getByText("Pick a project to check its Git status.")).toBeInTheDocument();
  });
});
