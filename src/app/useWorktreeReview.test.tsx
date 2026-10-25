// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorktreeDiff } from "../domain/worktree.model";

const api = vi.hoisted(() => ({
  worktreeDiff: vi.fn(),
  worktreeCommit: vi.fn(),
  worktreeMerge: vi.fn(),
  worktreeOpenPr: vi.fn(),
}));
vi.mock("../api", () => ({ api }));

import type { ReviewTarget } from "../stores/reviewStore";
import { useWorktreeReview } from "./useWorktreeReview";

const target: ReviewTarget = { workspaceId: "ws-1", terminalId: "t-1", label: "Vega" };

function diff(ahead = 1): WorktreeDiff {
  return {
    status: { branch: "terra/t-1", base: "main", path: "/Users/me/wt/t-1", dirty: [], ahead, behind: 0, exists: true },
    files: [{ path: "src/a.ts", change: "modified", additions: 1, deletions: 1 }],
    patch: "",
    truncated: false,
  };
}

describe("useWorktreeReview", () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockReset();
  });

  it("given no target, loads nothing", () => {
    const { result } = renderHook(() => useWorktreeReview(null));
    expect(api.worktreeDiff).not.toHaveBeenCalled();
    expect(result.current.diff).toBeNull();
  });

  it("given a target, loads its diff", async () => {
    api.worktreeDiff.mockResolvedValue(diff());
    const { result } = renderHook(() => useWorktreeReview(target));
    await waitFor(() => expect(result.current.diff).toEqual(diff()));
    expect(api.worktreeDiff).toHaveBeenCalledWith("ws-1", "t-1");
    expect(result.current.busy).toBeNull();
  });

  it("given the diff can't be read, reports the error", async () => {
    api.worktreeDiff.mockRejectedValue("not a git repository");
    const { result } = renderHook(() => useWorktreeReview(target));
    await waitFor(() => expect(result.current.error).toBe("not a git repository"));
    expect(result.current.diff).toBeNull();
  });

  it("given a merge that succeeds, tells the user and reloads the diff", async () => {
    api.worktreeDiff.mockResolvedValueOnce(diff(1)).mockResolvedValue(diff(0));
    api.worktreeMerge.mockResolvedValue(diff(0).status);
    const { result } = renderHook(() => useWorktreeReview(target));
    await waitFor(() => expect(result.current.diff).not.toBeNull());

    let isMerged = false;
    await act(async () => {
      isMerged = await result.current.merge();
    });

    expect(isMerged).toBe(true);
    expect(api.worktreeMerge).toHaveBeenCalledWith("ws-1", "t-1");
    expect(result.current.notice).toContain("terra/t-1");
    expect(result.current.diff?.status.ahead).toBe(0);
  });

  it("given a commit that fails, reports the error and resolves to false", async () => {
    api.worktreeDiff.mockResolvedValue(diff());
    api.worktreeCommit.mockRejectedValue("nothing to commit");
    const { result } = renderHook(() => useWorktreeReview(target));
    await waitFor(() => expect(result.current.diff).not.toBeNull());

    let isCommitted = true;
    await act(async () => {
      isCommitted = await result.current.commit("Changes from Vega");
    });

    expect(isCommitted).toBe(false);
    expect(api.worktreeCommit).toHaveBeenCalledWith("ws-1", "t-1", "Changes from Vega");
    expect(result.current.error).toBe("nothing to commit");
    expect(result.current.notice).toBeNull();
  });

  it("given a pull request is opened, keeps its URL", async () => {
    api.worktreeDiff.mockResolvedValue(diff());
    api.worktreeOpenPr.mockResolvedValue("https://example.test/pr/1");
    const { result } = renderHook(() => useWorktreeReview(target));
    await waitFor(() => expect(result.current.diff).not.toBeNull());

    await act(async () => {
      await result.current.openPullRequest("Changes from Vega", "");
    });

    expect(api.worktreeOpenPr).toHaveBeenCalledWith("ws-1", "t-1", "Changes from Vega", "");
    expect(result.current.prUrl).toBe("https://example.test/pr/1");
  });
});
