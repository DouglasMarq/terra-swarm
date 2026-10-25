// @vitest-environment jsdom

import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorktreeDiff } from "../../domain/worktree.model";

const api = vi.hoisted(() => ({
  worktreeDiff: vi.fn(),
  worktreeCommit: vi.fn(),
  worktreeMerge: vi.fn(),
  worktreeOpenPr: vi.fn(),
}));

vi.mock("../../api", () => ({ api }));

import { useReviewStore } from "../../stores/reviewStore";
import { WorktreeReviewDialog } from "./WorktreeReviewDialog";

function diff(extra: Partial<WorktreeDiff["status"]> = {}): WorktreeDiff {
  return {
    status: { branch: "terra/t-1", base: "main", path: "/wt", dirty: [], ahead: 2, behind: 0, isPresent: true, ...extra },
    files: [{ path: "src/a.ts", change: "modified", additions: 1, deletions: 1 }],
    patch: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
    isTruncated: false,
  };
}

describe("WorktreeReviewDialog", () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockReset();
  });

  afterEach(() => act(() => useReviewStore.getState().close()));

  it("Given a diff, when merging, then the merge runs only after a second click", async () => {
    api.worktreeDiff.mockResolvedValue(diff());
    api.worktreeMerge.mockResolvedValue(diff({ ahead: 0 }).status);
    render(<WorktreeReviewDialog />);
    act(() => useReviewStore.getState().open({ workspaceId: "ws", terminalId: "t-1", label: "Vega" }));

    expect(await screen.findByText("new")).toBeTruthy();
    expect(screen.getByText("old")).toBeTruthy();
    const merge = screen.getByRole("button", { name: /merge em main/i });
    await userEvent.click(merge);
    expect(api.worktreeMerge).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /clique de novo/i }));
    expect(api.worktreeMerge).toHaveBeenCalledWith("ws", "t-1");
    expect(await screen.findByRole("status")).toBeTruthy();
  });

  it("Given uncommitted work, when merging, then a commit is asked for first", async () => {
    api.worktreeDiff.mockResolvedValue(diff({ dirty: ["src/a.ts"] }));
    api.worktreeCommit.mockResolvedValue(diff().status);
    render(<WorktreeReviewDialog />);
    act(() => useReviewStore.getState().open({ workspaceId: "ws", terminalId: "t-1", label: "Vega" }));

    const commit = await screen.findByRole("button", { name: /commit de tudo/i });
    expect((screen.getByRole("button", { name: /merge em main/i }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(commit);
    expect(api.worktreeCommit).toHaveBeenCalledWith("ws", "t-1", "Changes from Vega");
  });

  it("Given the clipboard refuses the pull request link, when copying it, then it warns instead of failing silently", async () => {
    api.worktreeDiff.mockResolvedValue(diff());
    api.worktreeOpenPr.mockResolvedValue("https://example.test/pr/1");
    render(<WorktreeReviewDialog />);
    act(() => useReviewStore.getState().open({ workspaceId: "ws", terminalId: "t-1", label: "Vega" }));

    await userEvent.click(await screen.findByRole("button", { name: /abrir pull request/i }));
    await userEvent.click(screen.getByRole("button", { name: /enviar e abrir pr/i }));
    const copy = await screen.findByRole("button", { name: /copiar o link/i });
    const failure = new Error("clipboard denied");
    Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn().mockRejectedValue(failure) }, configurable: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fireEvent.click(copy);
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith("failed to copy the pull request URL:", failure));
    warn.mockRestore();
  });
});
