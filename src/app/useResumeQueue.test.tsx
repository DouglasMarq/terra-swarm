// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResumeItem } from "../domain/terminal.model";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { translateNow } from "../i18n";
import { usePreferencesStore } from "../stores/preferencesStore";
import { useTerminalRuntimeStore } from "../stores/terminalRuntimeStore";
import { type ResumeSessions, useResumeQueue } from "./useResumeQueue";

function itemFor(terminalId: string, wsName: string): ResumeItem {
  return { terminalId, wsId: "ws-1", wsName, cwd: "/repo", command: "claude", agentId: "claude", resumeCommand: "claude --continue" };
}

const first = itemFor("pty-1", "terra");
const second = itemFor("pty-2", "swarm");

type Results = Awaited<ReturnType<ResumeSessions["resumeItems"]>>;

function resultFor(id: string, status: Results[number]["status"]): Results[number] {
  return { id, status, startedAt: 0, finishedAt: 0 };
}

function fakeSessions() {
  return {
    resumeItem: vi.fn(async () => undefined),
    forget: vi.fn(),
    resumeItems: vi.fn(async (items: readonly ResumeItem[]): Promise<Results> => items.map((item) => resultFor(item.terminalId, "succeeded"))),
    notifyResumeFailures: vi.fn(),
  };
}

const runtime = () => useTerminalRuntimeStore.getState();
const notices = () => runtime().notifItems.map((item) => item.message);

describe("useResumeQueue", () => {
  let sessions: ReturnType<typeof fakeSessions>;
  let refresh: ReturnType<typeof vi.fn<() => Promise<void>>>;
  let consoleSpies: ReturnType<typeof vi.spyOn>[];

  function renderQueue() {
    return renderHook(() => useResumeQueue(sessions, refresh));
  }

  beforeEach(() => {
    sessions = fakeSessions();
    refresh = vi.fn(async () => undefined);
    invoke.mockReset().mockImplementation(async (command: string) => (command === "store_saved_at" ? 1_700_000_000 : undefined));
    consoleSpies = [vi.spyOn(console, "warn").mockImplementation(() => undefined), vi.spyOn(console, "error").mockImplementation(() => undefined)];
    usePreferencesStore.setState({ shouldAutoResume: false, agentNames: { "pty-1": "Vega" } });
  });

  afterEach(() => {
    for (const spy of consoleSpies) spy.mockRestore();
    runtime().reset();
  });

  it("Given items offered without auto resume, when shown and deferred, then the dialog opens and closes and the save time is read", async () => {
    const { result } = renderQueue();

    act(() => result.current.offer([first, second]));

    expect(result.current.isOpen).toBe(true);
    await vi.waitFor(() => expect(runtime().resumeSavedAt).toBe(1_700_000_000));
    act(() => result.current.defer());
    expect(result.current.isOpen).toBe(false);
    act(() => result.current.show());
    expect(result.current.isOpen).toBe(true);
  });

  it("Given the save time cannot be read, when offering, then the failure is only logged", async () => {
    invoke.mockRejectedValue(new Error("no store"));
    const { result } = renderQueue();

    act(() => result.current.offer([first]));

    await vi.waitFor(() => expect(console.warn).toHaveBeenCalled());
  });

  it("Given auto resume on, when items are offered, then all are resumed without opening the dialog", async () => {
    usePreferencesStore.setState({ shouldAutoResume: true });
    const { result } = renderQueue();

    act(() => result.current.offer([first, second]));

    await vi.waitFor(() => expect(sessions.resumeItems).toHaveBeenCalledWith([first, second]));
    await vi.waitFor(() => expect(runtime().resumeItems).toBeNull());
    expect(result.current.isOpen).toBe(false);
    expect(refresh).toHaveBeenCalled();
  });

  it("Given one item, when resuming it, then it leaves the queue, and a repeated click while busy is ignored", async () => {
    const { result } = renderQueue();
    act(() => result.current.offer([first, second]));

    await act(async () => {
      await Promise.all([result.current.resumeOne(first), result.current.resumeOne(first)]);
    });

    expect(sessions.resumeItem).toHaveBeenCalledTimes(1);
    expect(runtime().resumeItems).toEqual([second]);
    expect(refresh).toHaveBeenCalled();
  });

  it("Given resuming an item fails, when resuming it, then it stays queued and the user is told", async () => {
    sessions.resumeItem.mockRejectedValue(new Error("no pty"));
    const { result } = renderQueue();
    act(() => result.current.offer([first]));

    await act(() => result.current.resumeOne(first));

    expect(runtime().resumeItems).toEqual([first]);
    expect(notices()).toContain(translateNow("app.resumeFailed", { name: "terra", detail: "no pty" }));
  });

  it("Given one item, when dismissing it, then its terminal is killed and its name forgotten", async () => {
    const { result } = renderQueue();
    act(() => result.current.offer([first, second]));

    await act(() => result.current.dismissOne(first));

    expect(invoke).toHaveBeenCalledWith("kill_terminal", { id: "pty-1" });
    expect(sessions.forget).toHaveBeenCalledWith(["pty-1"]);
    expect(usePreferencesStore.getState().agentNames["pty-1"]).toBeUndefined();
    expect(runtime().resumeItems).toEqual([second]);
  });

  it("Given the kill fails, when dismissing one item, then it stays queued and the user is told", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "kill_terminal") throw new Error("busy");
      return null;
    });
    const { result } = renderQueue();
    act(() => result.current.offer([first]));

    await act(() => result.current.dismissOne(first));

    expect(runtime().resumeItems).toEqual([first]);
    expect(notices()).toContain(translateNow("app.dismissFailed", { name: "terra", detail: "busy" }));
  });

  it("Given some resumes fail, when resuming all, then only the failed items stay queued and failures are reported", async () => {
    sessions.resumeItems.mockResolvedValue([resultFor("pty-1", "succeeded"), resultFor("pty-2", "failed")]);
    const { result } = renderQueue();
    act(() => result.current.offer([first, second]));

    await act(() => result.current.resumeAll());

    expect(runtime().resumeItems).toEqual([second]);
    expect(sessions.notifyResumeFailures).toHaveBeenCalledWith(expect.any(Array), new Map([["pty-1", "terra"], ["pty-2", "swarm"]]));
  });

  it("Given an empty queue, when resuming or dismissing all, then nothing happens", async () => {
    const { result } = renderQueue();

    await act(() => result.current.resumeAll());
    await act(() => result.current.dismissAll());

    expect(sessions.resumeItems).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("Given one kill fails, when dismissing all, then the failed item stays queued and the others are forgotten", async () => {
    invoke.mockImplementation(async (command: string, payload?: { id: string }) => {
      if (command === "kill_terminal" && payload?.id === "pty-2") throw "locked";
      return null;
    });
    const { result } = renderQueue();
    act(() => result.current.offer([first, second]));

    await act(() => result.current.dismissAll());

    expect(runtime().resumeItems).toEqual([second]);
    expect(sessions.forget).toHaveBeenCalledWith(["pty-1"]);
    expect(notices()).toContain(translateNow("app.dismissFailed", { name: "swarm", detail: "locked" }));
  });

  it("Given every kill succeeds, when dismissing all, then the queue empties", async () => {
    const { result } = renderQueue();
    act(() => result.current.offer([first, second]));

    await act(() => result.current.dismissAll());

    expect(runtime().resumeItems).toBeNull();
    expect(result.current.isOpen).toBe(false);
  });

  it("Given a resume in progress, when another queue action starts, then it is ignored", async () => {
    let release: () => void = () => undefined;
    sessions.resumeItem.mockImplementation(() => new Promise<undefined>((resolve) => {
      release = () => resolve(undefined);
    }));
    const { result } = renderQueue();
    act(() => result.current.offer([first, second]));

    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = result.current.resumeOne(first);
    });
    await act(() => result.current.dismissOne(second));
    await act(() => result.current.resumeAll());
    await act(() => result.current.dismissAll());
    await act(() => result.current.resumeOne(second));
    release();
    await act(() => pending);

    expect(invoke).not.toHaveBeenCalledWith("kill_terminal", expect.anything());
    expect(sessions.resumeItems).not.toHaveBeenCalled();
    expect(sessions.resumeItem).toHaveBeenCalledTimes(1);
  });
});
