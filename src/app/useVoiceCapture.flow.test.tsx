// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import type { Terminal } from "@xterm/xterm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentInfo } from "../domain/agent.model";
import type { Workspace, WorkspaceGroup } from "../domain/workspace.model";

const tauri = vi.hoisted(() => {
  const handlers = new Map<string, (event: { payload: unknown }) => void>();
  return {
    handlers,
    unlisten: vi.fn(),
    invoke: vi.fn(),
  };
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, handler: (event: { payload: unknown }) => void) => {
    tauri.handlers.set(name, handler);
    return tauri.unlisten;
  },
}));

import { translateNow } from "../i18n";
import { registerTerminal, unregisterTerminal } from "../terminalRegistry";
import { usePreferencesStore } from "../stores/preferencesStore";
import { useShellStore } from "../stores/shellStore";
import { useTerminalRuntimeStore } from "../stores/terminalRuntimeStore";
import { useUiStore } from "../stores/uiStore";
import { useVoiceCapture } from "./useVoiceCapture";

const workspace: Workspace = {
  id: "ws-1",
  name: "terra",
  cwd: "/repo",
  terminals: [
    { id: "pty-1", command: "claude", width: null },
    { id: "pty-2", command: "codex", width: null, role: "orchestrator" },
    { id: "pty-3", command: "zsh", width: null },
  ],
};

const workspaces = [workspace];

const groups: WorkspaceGroup[] = [
  { id: "group-front", name: "Frontend", isCollapsed: false, projectIds: [], parentGroupId: null, isSuspended: false },
];

const agents: AgentInfo[] = [
  { id: "codex", label: "Codex", isAvailable: true },
  { id: "kimi", label: "Kimi", isAvailable: false },
];

type Options = {
  activeWorkspace?: Workspace | null;
  focusedId?: string | null;
  isVoiceEnabled?: boolean;
  isVoiceCommandsEnabled?: boolean;
};

function renderCapture({ activeWorkspace = workspace, focusedId = "pty-1", isVoiceEnabled = true, isVoiceCommandsEnabled = false }: Options = {}) {
  const actions = {
    quickNewTerminal: vi.fn(async () => undefined),
    selectWorkspace: vi.fn(),
    suspendGroup: vi.fn(async () => undefined),
    resumeGroup: vi.fn(async () => undefined),
  };
  const sessions = { spawnInto: vi.fn(async () => undefined), close: vi.fn(async () => undefined), restart: vi.fn(async () => undefined) };
  const openVoiceSettings = vi.fn();
  const view = renderHook(() =>
    useVoiceCapture({
      workspaces,
      groups,
      agents,
      activeWorkspace,
      focusedId,
      titles: {},
      isVoiceEnabled,
      isVoiceCommandsEnabled,
      sessions,
      openVoiceSettings,
      actions,
    }),
  );
  return { ...view, actions, sessions, openVoiceSettings, voice: () => view.result.current };
}

function emit(name: string, payload: unknown = null) {
  act(() => tauri.handlers.get(name)?.({ payload }));
}

const writes = () => tauri.invoke.mock.calls.filter(([command]) => command === "write_terminal");
const toggles = () => tauri.invoke.mock.calls.filter(([command]) => command === "voice_toggle_recording");

function fakeTerminal(isBracketed: boolean) {
  const focus = vi.fn();
  // The hook only reads bracketed paste mode and calls focus; a real xterm needs a DOM renderer.
  const partial: Pick<Terminal, "focus"> & { modes: Pick<Terminal["modes"], "bracketedPasteMode"> } = { modes: { bracketedPasteMode: isBracketed }, focus };
  const term = partial as Terminal;
  return { term, focus };
}

describe("useVoiceCapture flows", () => {
  let consoleSpies: ReturnType<typeof vi.spyOn>[];

  beforeEach(() => {
    tauri.handlers.clear();
    tauri.unlisten.mockReset();
    tauri.invoke.mockReset().mockResolvedValue(undefined);
    consoleSpies = [vi.spyOn(console, "warn").mockImplementation(() => undefined), vi.spyOn(console, "error").mockImplementation(() => undefined)];
    usePreferencesStore.setState({ shouldSendVoiceToOrchestrator: false, agentNames: {} });
    useUiStore.setState({ focusedId: null });
  });

  afterEach(() => {
    for (const spy of consoleSpies) spy.mockRestore();
    useTerminalRuntimeStore.getState().reset();
    vi.useRealTimers();
  });

  it("Given a recording, when it starts, reports levels and stops, then status, level and samples follow", () => {
    const { voice } = renderCapture();

    emit("voice-recording-started");
    expect(voice().status).toBe("recording");

    emit("voice-audio-level", 0.5);
    emit("voice-audio-level", 7);
    emit("voice-audio-level", "noise");
    expect(voice().level).toBe(0);
    expect(voice().samples).toEqual([0.5, 1, 0]);

    emit("voice-recording-stopped");
    expect(voice().status).toBe("transcribing");
    emit("voice-transcription-started");
    expect(voice().capsule.state).not.toBe("idle");
  });

  it("Given an empty transcript, when it completes, then the user is asked to try again", () => {
    const { voice } = renderCapture();

    emit("voice-transcription-complete", "   ");

    expect(voice().status).toBe("idle");
    expect(voice().feedback).toBe(translateNow("app.voice.noTranscript"));
  });

  it("Given a focused bracketed terminal, when dictation completes, then it is pasted, the terminal is focused and it is marked sent", async () => {
    const { term, focus } = fakeTerminal(true);
    registerTerminal("pty-1", term);
    const { voice } = renderCapture();

    emit("voice-transcription-complete", "run the tests");

    await vi.waitFor(() => expect(voice().isSubmitted).toBe(true));
    expect(writes()).toHaveLength(1);
    expect(writes()[0][1]).toMatchObject({ id: "pty-1" });
    expect(focus).toHaveBeenCalled();
    expect(voice().feedback).toBe(translateNow("app.voice.sent"));
    unregisterTerminal("pty-1", term);
  });

  it("Given no target at all, when dictation completes, then the user is asked to pick one", () => {
    const { voice } = renderCapture({ focusedId: null });

    emit("voice-transcription-complete", "hello");

    expect(voice().feedback).toBe(translateNow("app.voice.readyPickTarget"));
    expect(voice().targetLabel).toBeNull();
  });

  it("Given voice commands on, when a destructive and a plain command are transcribed, then each is held for review", () => {
    const { voice } = renderCapture({ isVoiceCommandsEnabled: true });

    emit("voice-transcription-complete", "suspender grupo Frontend");
    expect(voice().feedback).toBe(translateNow("app.voice.reviewDestructive"));
    expect(voice().targetLabel).toBe("frontend");

    emit("voice-transcription-complete", "abrir frota");
    expect(voice().feedback).toBe(translateNow("app.voice.reviewIntent"));
    expect(voice().targetLabel).toBe(translateNow("app.voice.fleet"));
    expect(writes()).toHaveLength(0);
  });

  it("Given voice commands on but no command in the speech, when it completes, then it is dictated with the agent prompt", async () => {
    const { voice } = renderCapture({ isVoiceCommandsEnabled: true });

    emit("voice-transcription-complete", "explain this file");

    await vi.waitFor(() => expect(voice().isSubmitted).toBe(true));
    expect(writes()).toHaveLength(1);
  });

  it("Given a write that fails, when dictating, then the capsule fails with the send error", async () => {
    tauri.invoke.mockRejectedValue(new Error("pty closed"));
    const { voice } = renderCapture();

    await act(() => voice().send({ transcript: "hello", intent: null, agent: null }, false));

    expect(voice().feedback).toBe(translateNow("app.voice.sendFailed"));
    expect(voice().capsule.state).toBe("error");
  });

  it("Given a target that is neither registered nor known, when dictating, then it is reported unavailable", async () => {
    const { voice } = renderCapture({ focusedId: "pty-ghost" });

    await act(() => voice().send({ transcript: "hello", intent: null, agent: null }, false));

    expect(voice().feedback).toBe(translateNow("app.voice.targetUnavailable"));
    expect(writes()).toHaveLength(0);
  });

  it("Given no target, when sending dictation, then the user is asked to pick one", async () => {
    const { voice } = renderCapture({ focusedId: null });

    await act(() => voice().send({ transcript: "hello", intent: null, agent: null }, false));

    expect(voice().feedback).toBe(translateNow("app.voice.pickTarget"));
  });

  it("Given an exited target, when dictating, then the agent is resumed first and the text is sent after a pause", async () => {
    vi.useFakeTimers();
    useTerminalRuntimeStore.getState().setExited({ "pty-1": 0 });
    const { voice, sessions } = renderCapture();

    let sending: Promise<void> = Promise.resolve();
    act(() => {
      sending = voice().send({ transcript: "continue", intent: null, agent: null }, false);
    });
    await act(() => vi.advanceTimersByTimeAsync(1500));
    await act(() => sending);

    expect(sessions.restart).toHaveBeenCalledWith("pty-1", expect.stringContaining("claude"));
    expect(writes()).toHaveLength(1);
  });

  it("Given the orchestrator preference, when no target is chosen, then the orchestrator is the target and its label shows", () => {
    usePreferencesStore.setState({ shouldSendVoiceToOrchestrator: true });
    const { voice } = renderCapture();

    expect(voice().targetId).toBe("pty-2");
    expect(voice().targetLabel).toBeTruthy();

    act(() => voice().setTargetId("pty-3"));
    expect(voice().targetId).toBe("pty-3");
  });

  it("Given an open-fleet intent, when sent, then the fleet opens", async () => {
    const { voice } = renderCapture();

    await act(() => voice().send({ transcript: "abrir frota", intent: { type: "open-fleet" }, agent: null }, false));

    expect(useShellStore.getState().activeSurface).toBe("fleet");
    expect(voice().isSubmitted).toBe(true);
  });

  it("Given focus intents for a known and an unknown terminal, when sent, then the known one is focused and the other reported", async () => {
    const { voice, actions } = renderCapture();

    await act(() => voice().send({ transcript: "", intent: { type: "focus", target: "pty-3" }, agent: null }, false));
    expect(useUiStore.getState().focusedId).toBe("pty-3");
    expect(actions.selectWorkspace).toHaveBeenCalledWith("ws-1");
    expect(voice().feedback).toBe(translateNow("app.voice.focusChanged", { name: "pty-3" }));

    await act(() => voice().send({ transcript: "", intent: { type: "focus", target: "nowhere" }, agent: null }, false));
    expect(voice().feedback).toBe(translateNow("app.voice.terminalNotFound", { name: "nowhere" }));
  });

  it("Given a destructive intent without confirmation, when sent, then confirmation is requested", async () => {
    const { voice, actions } = renderCapture();

    await act(() => voice().send({ transcript: "", intent: { type: "suspend-group", group: "Frontend" }, agent: null }, false));

    expect(actions.suspendGroup).not.toHaveBeenCalled();
    expect(voice().feedback).toBe(translateNow("app.voice.confirmDestructive"));
  });

  it("Given a resume intent for a known group, when sent, then the group resumes", async () => {
    const { voice, actions } = renderCapture();

    await act(() => voice().send({ transcript: "", intent: { type: "resume-group", group: "Frontend" }, agent: null }, false));

    expect(actions.resumeGroup).toHaveBeenCalledWith("group-front");
    expect(voice().feedback).toBe(translateNow("app.voice.groupResumed", { name: "Frontend" }));
  });

  it("Given new-agent intents, when sent with no agent, a known agent and an unavailable one, then each is handled", async () => {
    const { voice, actions, sessions } = renderCapture();

    await act(() => voice().send({ transcript: "", intent: { type: "new-agent" }, agent: null }, false));
    expect(actions.quickNewTerminal).toHaveBeenCalledWith("ws-1");
    expect(voice().feedback).toBe(translateNow("app.voice.agentReady"));

    await act(() => voice().send({ transcript: "", intent: { type: "new-agent", agent: "Codex" }, agent: null }, false));
    expect(sessions.spawnInto).toHaveBeenCalledWith("ws-1", "codex");

    await act(() => voice().send({ transcript: "", intent: { type: "new-agent", agent: "Kimi" }, agent: null }, false));
    expect(useTerminalRuntimeStore.getState().notifItems[0]?.message).toBe(translateNow("app.agentUnavailable", { name: "Kimi" }));
  });

  it("Given no active workspace, when starting a new agent by voice, then the user is asked to pick a workspace", async () => {
    const { voice } = renderCapture({ activeWorkspace: null });

    await act(() => voice().send({ transcript: "", intent: { type: "new-agent" }, agent: null }, false));

    expect(useTerminalRuntimeStore.getState().notifItems[0]?.message).toBe(translateNow("app.pickWorkspaceFirst"));
  });

  it("Given confirmed stop intents, when sent for a known, an unknown and no terminal, then only the known one closes", async () => {
    const { voice, sessions } = renderCapture();

    await act(() => voice().send({ transcript: "", intent: { type: "stop", target: "pty-3" }, agent: null }, true));
    expect(sessions.close).toHaveBeenCalledWith("pty-3");
    expect(voice().feedback).toBe(translateNow("app.voice.terminalStopped", { name: "pty-3" }));

    await act(() => voice().send({ transcript: "", intent: { type: "stop", target: "ghost" }, agent: null }, true));
    expect(voice().feedback).toBe(translateNow("app.voice.terminalNotFound", { name: "ghost" }));

    await act(() => voice().send({ transcript: "", intent: { type: "stop" }, agent: null }, true));
    expect(voice().feedback).toBe(translateNow("app.voice.whichStop"));
    expect(sessions.close).toHaveBeenCalledTimes(1);
  });

  it("Given an intent whose action throws, when sent, then the failure is reported", async () => {
    const { voice, actions } = renderCapture();
    actions.resumeGroup.mockRejectedValue(new Error("backend down"));

    await act(() => voice().send({ transcript: "", intent: { type: "resume-group", group: "Frontend" }, agent: null }, false));

    expect(voice().feedback).toBe(translateNow("app.voice.actionFailed"));
    expect(voice().isSubmitted).toBe(false);
  });

  it("Given voice disabled, when toggling, starting or retrying, then voice settings open instead of recording", () => {
    const { voice, openVoiceSettings } = renderCapture({ isVoiceEnabled: false });

    act(() => voice().toggle());
    act(() => voice().start());
    act(() => voice().retry());

    expect(openVoiceSettings).toHaveBeenCalledTimes(3);
    expect(toggles()).toHaveLength(0);
  });

  it("Given voice enabled, when toggling, starting and retrying, then recording is toggled each time", async () => {
    const { voice } = renderCapture();

    act(() => voice().toggle());
    act(() => voice().start());
    act(() => voice().retry());

    expect(toggles()).toHaveLength(3);
  });

  it("Given start and retry fail, when invoked, then their failures are shown", async () => {
    tauri.invoke.mockRejectedValue(new Error("no mic"));
    const { voice } = renderCapture();

    act(() => voice().toggle());
    act(() => voice().start());
    await vi.waitFor(() => expect(voice().feedback).toBe(translateNow("app.voice.startFailed")));

    act(() => voice().retry());
    await vi.waitFor(() => expect(voice().feedback).toBe(translateNow("app.voice.retryFailed")));
  });

  it("Given an idle capture, when stopping, then nothing is toggled", () => {
    const { voice } = renderCapture();

    act(() => voice().stop());

    expect(toggles()).toHaveLength(0);
  });

  it("Given a recording, when stopping fails, then the failure is shown", async () => {
    tauri.invoke.mockRejectedValue(new Error("stuck"));
    const { voice } = renderCapture();
    emit("voice-recording-started");

    act(() => voice().stop());

    await vi.waitFor(() => expect(voice().feedback).toBe(translateNow("app.voice.stopFailed")));
  });

  it("Given a recording, when cancelling, then recording stops and the capture resets", async () => {
    tauri.invoke.mockRejectedValue(new Error("already stopped"));
    const { voice } = renderCapture();
    emit("voice-recording-started");
    emit("voice-audio-level", 0.4);

    act(() => voice().cancel());

    expect(toggles()).toHaveLength(1);
    expect(voice()).toMatchObject({ status: "idle", level: 0, samples: [], feedback: null, isSubmitted: false });
  });

  it("Given an idle capture, when cancelling, then nothing is toggled", () => {
    const { voice } = renderCapture();

    act(() => voice().cancel());

    expect(toggles()).toHaveLength(0);
  });

  it("Given a recording error with a message, when it arrives, then that message is shown, and unmounting stops listening", async () => {
    const { voice, unmount, openVoiceSettings } = renderCapture();

    emit("voice-recording-error", "Device unplugged");

    expect(voice().feedback).toBe("Device unplugged");
    expect(openVoiceSettings).not.toHaveBeenCalled();
    unmount();
    await vi.waitFor(() => expect(tauri.unlisten).toHaveBeenCalledTimes(7));
  });
});
