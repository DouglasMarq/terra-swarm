// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceModelInfo } from "../domain/voice.model";

const tauri = vi.hoisted(() => {
  const handlers = new Map<string, (event: { payload: unknown }) => void>();
  const unlisten = vi.fn();
  return {
    handlers,
    unlisten,
    invoke: vi.fn(),
    listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
      handlers.set(name, handler);
      return unlisten;
    }),
  };
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: tauri.listen }));

import { usePreferencesStore } from "../stores/preferencesStore";
import { useTerminalRuntimeStore } from "../stores/terminalRuntimeStore";
import { useVoiceSettings } from "./useVoiceSettings";

const model: VoiceModelInfo = { id: "base", displayName: "Base", sizeLabel: "140 MB", description: "", isDownloaded: true, isActive: true };

type Responses = Record<string, unknown>;

function backend(responses: Responses = {}, failing: Record<string, unknown> = {}) {
  const defaults: Responses = {
    voice_list_models: [model],
    voice_list_input_devices: ["Built-in", "USB Mic"],
    voice_is_mic_available: true,
    list_available_shells: ["/bin/zsh"],
  };
  tauri.invoke.mockImplementation(async (command: string) => {
    if (command in failing) throw failing[command];
    return { ...defaults, ...responses }[command];
  });
}

const sent = (command: string) => tauri.invoke.mock.calls.filter(([name]) => name === command).map(([, payload]) => payload);
const lastNotice = () => useTerminalRuntimeStore.getState().notifItems[0]?.message;
const prefs = () => usePreferencesStore.getState();

function emit(name: string, payload: unknown) {
  act(() => tauri.handlers.get(name)?.({ payload }));
}

function renderSettings(initial = { isSettingsOpen: false, isVoiceSectionOpen: true }) {
  return renderHook((props) => useVoiceSettings(props), { initialProps: initial });
}

describe("useVoiceSettings", () => {
  let consoleSpies: ReturnType<typeof vi.spyOn>[];

  beforeEach(() => {
    tauri.handlers.clear();
    tauri.invoke.mockReset();
    tauri.unlisten.mockReset();
    backend();
    consoleSpies = [vi.spyOn(console, "warn").mockImplementation(() => undefined), vi.spyOn(console, "error").mockImplementation(() => undefined)];
    usePreferencesStore.setState({ isVoiceEnabled: false, voiceLang: "pt", voiceInputDevice: null, voiceModel: null });
  });

  afterEach(() => {
    for (const spy of consoleSpies) spy.mockRestore();
    useTerminalRuntimeStore.getState().reset();
    localStorage.clear();
  });

  it("Given the settings open with voice on, when they load, then the mic, models, devices and shells are fetched", async () => {
    usePreferencesStore.setState({ isVoiceEnabled: true });
    const { result } = renderSettings({ isSettingsOpen: true, isVoiceSectionOpen: true });

    await vi.waitFor(() => expect(result.current.modelsStatus).toBe("ready"));
    await vi.waitFor(() => expect(result.current.availableShells).toEqual(["/bin/zsh"]));
    expect(result.current.models).toEqual([model]);
    expect(result.current.inputDevices).toEqual(["Built-in", "USB Mic"]);
    expect(result.current.isMicAvailable).toBe(true);
  });

  it("Given the model list fails, when the settings open, then the models are in error", async () => {
    backend({}, { voice_list_models: new Error("no models dir"), list_available_shells: new Error("no shells") });
    const { result } = renderSettings({ isSettingsOpen: true, isVoiceSectionOpen: true });

    await vi.waitFor(() => expect(result.current.modelsStatus).toBe("error"));
    expect(result.current.inputDevices).toEqual([]);
  });

  it("Given voice is off, when applying stored settings, then nothing is sent", () => {
    const { result } = renderSettings();

    act(() => result.current.applyStoredSettings());

    expect(tauri.invoke).not.toHaveBeenCalled();
  });

  it("Given voice on with stored choices, when applying them, then language, device and model are pushed to the backend", async () => {
    usePreferencesStore.setState({ isVoiceEnabled: true, voiceLang: "en", voiceInputDevice: "USB Mic", voiceModel: "base" });
    const { result } = renderSettings();

    act(() => result.current.applyStoredSettings());

    await vi.waitFor(() => expect(result.current.isMicAvailable).toBe(true));
    expect(sent("voice_set_language")).toEqual([{ language: "en" }]);
    expect(sent("voice_set_input_device")).toEqual([{ device: "USB Mic" }]);
    expect(sent("voice_set_model")).toEqual([{ modelId: "base" }]);
  });

  it("Given voice on but no microphone, when applying stored settings, then voice is switched off quietly", async () => {
    usePreferencesStore.setState({ isVoiceEnabled: true });
    backend({ voice_is_mic_available: false });
    const { result } = renderSettings();

    act(() => result.current.applyStoredSettings());

    await vi.waitFor(() => expect(prefs().isVoiceEnabled).toBe(false));
    expect(lastNotice()).toBeUndefined();
  });

  it("Given a stored model that fails to load, when applying settings, then the model is cleared and the user is told", async () => {
    usePreferencesStore.setState({ isVoiceEnabled: true, voiceModel: "broken" });
    backend({}, { voice_set_model: new Error("bad file") });
    const { result } = renderSettings();

    act(() => result.current.applyStoredSettings());

    await vi.waitFor(() => expect(lastNotice()).toBe("O modelo de voz não carregou. Selecione-o de novo."));
    expect(prefs().voiceModel).toBeNull();
    await vi.waitFor(() => expect(result.current.modelsStatus).toBe("ready"));
  });

  it("Given a microphone, when enabling voice, then voice turns on and models and devices load", async () => {
    const { result } = renderSettings();

    act(() => result.current.setEnabled(true));

    await vi.waitFor(() => expect(prefs().isVoiceEnabled).toBe(true));
    await vi.waitFor(() => expect(result.current.inputDevices).toHaveLength(2));
    expect(result.current.modelsStatus).toBe("ready");
  });

  it("Given no microphone, when enabling voice, then voice stays off", async () => {
    backend({ voice_is_mic_available: false });
    const { result } = renderSettings();

    act(() => result.current.setEnabled(true));

    await vi.waitFor(() => expect(result.current.isMicAvailable).toBe(false));
    expect(prefs().isVoiceEnabled).toBe(false);
  });

  it("Given voice on, when disabling it, then it turns off without asking the backend", () => {
    usePreferencesStore.setState({ isVoiceEnabled: true });
    const { result } = renderSettings();

    act(() => result.current.setEnabled(false));

    expect(prefs().isVoiceEnabled).toBe(false);
    expect(tauri.invoke).not.toHaveBeenCalled();
  });

  it("Given a language and a device, when choosing them, then the preference and the backend follow, and blank means default", () => {
    const { result } = renderSettings();

    act(() => result.current.setLanguage("es"));
    act(() => result.current.setInputDevice("USB Mic"));
    act(() => result.current.setInputDevice(""));

    expect(prefs().voiceLang).toBe("es");
    expect(prefs().voiceInputDevice).toBeNull();
    expect(sent("voice_set_input_device")).toEqual([{ device: "USB Mic" }, { device: null }]);
  });

  it("Given a running mic test, when switching device and toggling again, then the test restarts on the device and then stops", async () => {
    const { result } = renderSettings();

    act(() => result.current.toggleMicTest());
    await vi.waitFor(() => expect(result.current.isMicTesting).toBe(true));
    act(() => result.current.setInputDevice("USB Mic"));
    act(() => result.current.toggleMicTest());

    expect(sent("voice_test_mic_start")).toEqual([{ device: null }, { device: "USB Mic" }]);
    expect(sent("voice_test_mic_stop")).toHaveLength(1);
    expect(result.current.isMicTesting).toBe(false);
  });

  it("Given the mic test fails with a message or an error, when starting it, then the user sees the message or a generic notice", async () => {
    backend({}, { voice_test_mic_start: "Device busy" });
    const { result } = renderSettings();

    act(() => result.current.toggleMicTest());
    await vi.waitFor(() => expect(lastNotice()).toBe("Device busy"));

    backend({}, { voice_test_mic_start: new Error("boom") });
    act(() => result.current.toggleMicTest());
    await vi.waitFor(() => expect(lastNotice()).toBe("Não foi possível iniciar o teste do microfone."));
  });

  it("Given a running mic test, when the voice section closes, then the test stops", async () => {
    const view = renderSettings();
    act(() => view.result.current.toggleMicTest());
    await vi.waitFor(() => expect(view.result.current.isMicTesting).toBe(true));

    view.rerender({ isSettingsOpen: false, isVoiceSectionOpen: false });

    expect(view.result.current.isMicTesting).toBe(false);
    expect(sent("voice_test_mic_stop")).toHaveLength(1);
  });

  it("Given a model, when selecting it, then the backend loads it", () => {
    const { result } = renderSettings();

    act(() => result.current.selectModel("small"));

    expect(sent("voice_set_model")).toEqual([{ modelId: "small" }]);
  });

  it("Given a download, when progress and completion arrive, then progress shows and clears and models refresh", async () => {
    const { result } = renderSettings();

    act(() => result.current.downloadModel("small"));
    expect(result.current.download).toEqual({ id: "small", percent: 0 });

    emit("voice-model-download-progress", { model_id: "small", downloaded: 5, total: 10, percent: 50 });
    expect(result.current.download).toEqual({ id: "small", percent: 50 });

    emit("voice-model-download-complete", null);
    expect(result.current.download).toBeNull();
    await vi.waitFor(() => expect(result.current.modelsStatus).toBe("ready"));
  });

  it("Given a download that fails, when downloading, then the progress clears", async () => {
    backend({}, { voice_download_model: new Error("offline") });
    const { result } = renderSettings();

    act(() => result.current.downloadModel("small"));

    await vi.waitFor(() => expect(result.current.download).toBeNull());
  });

  it("Given the backend switches model, when notified, then the preference follows", () => {
    renderSettings();

    emit("voice-model-changed", "large");

    expect(prefs().voiceModel).toBe("large");
  });

  it("Given voice on, when the microphone disconnects, then voice turns off and the user is told", async () => {
    usePreferencesStore.setState({ isVoiceEnabled: true });
    const { result } = renderSettings();

    emit("voice-mic-changed", false);

    expect(result.current.isMicAvailable).toBe(false);
    expect(prefs().isVoiceEnabled).toBe(false);
    expect(lastNotice()).toBe("Microfone desconectado. A entrada de voz foi desligada.");
  });

  it("Given voice off, when a microphone connects, then the devices refresh without a notice, and unmounting stops listening", async () => {
    const { result, unmount } = renderSettings();

    emit("voice-mic-changed", true);

    await vi.waitFor(() => expect(result.current.inputDevices).toHaveLength(2));
    expect(lastNotice()).toBeUndefined();
    unmount();
    await vi.waitFor(() => expect(tauri.unlisten).toHaveBeenCalledTimes(4));
  });
});
