// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceGroup } from "../domain/workspace.model";

const voiceEvents = vi.hoisted(() => {
  const handlers = new Map<string, (payload: string) => void>();
  const listen = (name: string) => (handler: (payload: string) => void) => {
    handlers.set(name, handler);
    return Promise.resolve(() => undefined);
  };
  return {
    handlers,
    module: {
      onVoiceAudioLevel: listen("audioLevel"),
      onVoiceRecordingError: listen("recordingError"),
      onVoiceRecordingStarted: listen("recordingStarted"),
      onVoiceRecordingStopped: listen("recordingStopped"),
      onVoiceTranscriptionComplete: listen("transcriptionComplete"),
      onVoiceTranscriptionError: listen("transcriptionError"),
      onVoiceTranscriptionStarted: listen("transcriptionStarted"),
    },
  };
});
vi.mock("../lib/tauri/voice", () => voiceEvents.module);
vi.mock("../api", () => ({ api: { voiceToggleRecording: vi.fn(async () => undefined) } }));

import { useTerminalRuntimeStore } from "../stores/terminalRuntimeStore";
import { useVoiceCapture } from "./useVoiceCapture";
import type { TerminalSessions } from "./useTerminalSessions";

const groups: WorkspaceGroup[] = [
  { id: "group-front", name: "Frontend", collapsed: false, projectIds: [], parentGroupId: null, suspended: false },
];

function renderVoiceCapture() {
  const actions = {
    quickNewTerminal: vi.fn(async () => undefined),
    selectWorkspace: vi.fn(),
    suspendGroup: vi.fn(async () => undefined),
    resumeGroup: vi.fn(async () => undefined),
  };
  const openVoiceSettings = vi.fn();
  // The voice flows under test never reach the terminal sessions, so an empty fake is enough.
  const sessions = {} as unknown as TerminalSessions;
  const { result } = renderHook(() =>
    useVoiceCapture({
      workspaces: [],
      groups,
      agents: [],
      activeWorkspace: null,
      focusedId: null,
      titles: {},
      voiceEnabled: true,
      voiceCommandsEnabled: true,
      sessions,
      openVoiceSettings,
      actions,
    }),
  );
  return { result, actions, openVoiceSettings };
}

describe("useVoiceCapture", () => {
  beforeEach(() => {
    useTerminalRuntimeStore.setState({ notifItems: [] });
  });

  it("Given a confirmed suspend intent for a known group, when sent, then the group is suspended and the capture is submitted", async () => {
    const { result, actions } = renderVoiceCapture();

    await act(() =>
      result.current.send({ transcript: "suspend frontend", intent: { type: "suspend-group", group: "Frontend" }, agent: null }, true),
    );

    expect(actions.suspendGroup).toHaveBeenCalledWith("group-front");
    expect(result.current.submitted).toBe(true);
  });

  it("Given a resume intent for an unknown group, when sent, then nothing resumes and the user is told", async () => {
    const { result, actions } = renderVoiceCapture();

    await act(() =>
      result.current.send({ transcript: "resume backend", intent: { type: "resume-group", group: "Backend" }, agent: null }, false),
    );

    expect(actions.resumeGroup).not.toHaveBeenCalled();
    expect(result.current.submitted).toBe(false);
    expect(useTerminalRuntimeStore.getState().notifItems).toHaveLength(1);
  });

  it("Given a transcription error about the speech model, when it arrives, then the capsule fails and voice settings open", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { result, openVoiceSettings } = renderVoiceCapture();

    act(() => voiceEvents.handlers.get("transcriptionError")?.("whisper model missing"));

    expect(result.current.feedback).toBe("whisper model missing");
    expect(result.current.status).toBe("idle");
    expect(openVoiceSettings).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });

  it("Given an empty recording error, when it arrives, then the fallback message is shown without opening settings", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { result, openVoiceSettings } = renderVoiceCapture();

    act(() => voiceEvents.handlers.get("recordingError")?.(""));

    expect(result.current.feedback).toBeTruthy();
    expect(openVoiceSettings).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
