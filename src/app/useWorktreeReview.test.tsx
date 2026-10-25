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

import { translateNow } from "../i18n";
import type { ReviewTarget } from "../stores/reviewStore";
import { useWorktreeReview } from "./useWorktreeReview";

const target: ReviewTarget = { workspaceId: "ws-1", terminalId: "t-1", label: "Vega" };

function diff(ahead = 1): WorktreeDiff {
  return {
    status: { branch: "terra/t-1", base: "main", path: "/Users/me/wt/t-1", dirty: [], ahead, behind: 0, isPresent: true },
    files: [{ path: "src/a.ts", change: "modified", additions: 1, deletions: 1 }],
    patch: "",
    isTruncated: false,
  };
}

describe("useWorktreeReview", () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockReset();
  });

  it("Given no target, when the hook runs, then it loads nothing", () => {
    const { result } = renderHook(() => useWorktreeReview(null));
    expect(api.worktreeDiff).not.toHaveBeenCalled();
    expect(result.current.diff).toBeNull();
  });

  it("Given a target, when the hook runs, then it loads its diff", async () => {
    api.worktreeDiff.mockResolvedValue(diff());
    const { result } = renderHook(() => useWorktreeReview(target));
    await waitFor(() => expect(result.current.diff).toEqual(diff()));
    expect(api.worktreeDiff).toHaveBeenCalledWith("ws-1", "t-1");
    expect(result.current.busy).toBeNull();
  });

  it("Given the diff can't be read, when loading, then it reports the error", async () => {
    api.worktreeDiff.mockRejectedValue("not a git repository");
    const { result } = renderHook(() => useWorktreeReview(target));
    await waitFor(() => expect(result.current.error).toBe("not a git repository"));
    expect(result.current.diff).toBeNull();
  });

  it("Given a merge that succeeds, when merging, then it tells the user and reloads the diff", async () => {
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

  it("Given a commit that fails, when committing, then it reports the error and resolves to false", async () => {
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

  it("Given a pull request is opened, when the action finishes, then its URL is kept", async () => {
    api.worktreeDiff.mockResolvedValue(diff());
    api.worktreeOpenPr.mockResolvedValue("https://example.test/pr/1");
    const { result } = renderHook(() => useWorktreeReview(target));
    await waitFor(() => expect(result.current.diff).not.toBeNull());

    await act(async () => {
      await result.current.openPullRequest("Changes from Vega", "");
    });

    expect(api.worktreeOpenPr).toHaveBeenCalledWith({ workspaceId: "ws-1", terminalId: "t-1", title: "Changes from Vega", body: "" });
    expect(result.current.prUrl).toBe("https://example.test/pr/1");
  });

  it("Given no target, when running an action, then it resolves to false without calling the backend", async () => {
    const { result } = renderHook(() => useWorktreeReview(null));

    let isMerged = true;
    await act(async () => {
      isMerged = await result.current.merge();
    });

    expect(isMerged).toBe(false);
    expect(api.worktreeMerge).not.toHaveBeenCalled();
  });

  it("Given no diff loaded yet, when merging, then the notice names empty branches", async () => {
    api.worktreeDiff.mockRejectedValueOnce(new Error("busy")).mockResolvedValue(diff());
    api.worktreeMerge.mockResolvedValue(undefined);
    const { result } = renderHook(() => useWorktreeReview(target));
    await waitFor(() => expect(result.current.error).not.toBeNull());

    await act(async () => {
      await result.current.merge();
    });

    expect(result.current.notice).toBe(translateNow("review.merged", { branch: "", base: "" }));
  });
});
