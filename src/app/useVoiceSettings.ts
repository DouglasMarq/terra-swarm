import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "../api";
import type { VoiceDownloadProgress, VoiceModelInfo } from "../types";
import { t } from "../i18n";
import { usePreferencesStore } from "../stores/preferencesStore";
import type { VoiceLanguage } from "../domain/voiceLanguages";
import { useTerminalRuntimeStore } from "../stores/terminalRuntimeStore";

const warn = (what: string) => (error: unknown) => console.warn(`${what}:`, error);

interface VoiceSettingsInput {
  /** The Settings page is open: refresh what it shows. */
  settingsOpen: boolean;
  /** Its Voice section is the one on screen (the mic test lives there). */
  voiceSectionOpen: boolean;
}

/**
 * Everything the Voice settings need: whether a microphone exists, the input
 * devices, the Whisper models and their downloads, the mic test, and pushing
 * the stored choices into the backend.
 */
export function useVoiceSettings({ settingsOpen, voiceSectionOpen }: VoiceSettingsInput) {
  const prefs = usePreferencesStore;
  const voiceEnabled = usePreferencesStore((state) => state.voiceEnabled);
  const [inputDevices, setInputDevices] = useState<string[]>([]);
  const [micAvailable, setMicAvailable] = useState<boolean | null>(null);
  const [micTesting, setMicTesting] = useState(false);
  const [models, setModels] = useState<VoiceModelInfo[]>([]);
  const [modelsStatus, setModelsStatus] = useState<"loading" | "ready" | "error">("loading");
  const [download, setDownload] = useState<{ id: string; percent: number } | null>(null);
  const [availableShells, setAvailableShells] = useState<string[]>([]);
  const notify = (message: string) => useTerminalRuntimeStore.getState().pushSystemNotification(message);

  const refreshModels = useCallback(() => {
    api
      .voiceListModels()
      .then((list) => {
        setModels(list);
        setModelsStatus("ready");
      })
      .catch((error) => {
        console.error("voice model list failed:", error);
        setModelsStatus("error");
      });
  }, []);

  const refreshInputDevices = useCallback(() => {
    api.voiceListInputDevices().then(setInputDevices).catch(warn("could not list input devices"));
  }, []);

  const handleModelLoadError = (error: unknown) => {
    console.error("voice model load failed:", error);
    prefs.getState().setVoiceModel(null);
    refreshModels();
    notify(t("app.voice.modelLoadFailed"));
  };

  const disableVoice = (announce: boolean) => {
    prefs.getState().setVoiceEnabled(false);
    if (announce) notify(t("app.voice.micDisconnected"));
  };

  /** Send the stored language, device and model to the backend. */
  const pushStoredSettings = () => {
    const { voiceLang, voiceInputDevice, voiceModel } = prefs.getState();
    api.voiceSetLanguage(voiceLang).catch(warn("could not set the voice language"));
    api.voiceSetInputDevice(voiceInputDevice).catch(warn("could not set the input device"));
    if (voiceModel) api.voiceSetModel(voiceModel).catch(handleModelLoadError);
  };

  /**
   * At startup: if voice was left on, push its settings (the model loads in
   * the background) — or turn it off when the microphone is gone.
   */
  const applyStoredSettings = () => {
    if (!prefs.getState().voiceEnabled) return;
    api
      .voiceMicAvailable()
      .then((available) => {
        setMicAvailable(available);
        if (!available) disableVoice(false);
      })
      .catch(warn("could not check the microphone"));
    pushStoredSettings();
  };

  const setEnabled = (on: boolean) => {
    if (!on) {
      prefs.getState().setVoiceEnabled(false);
      return;
    }
    // Never turn voice on without a microphone.
    api
      .voiceMicAvailable()
      .then((available) => {
        setMicAvailable(available);
        if (!available) return;
        prefs.getState().setVoiceEnabled(true);
        pushStoredSettings();
        refreshModels();
        refreshInputDevices();
      })
      .catch(warn("could not check the microphone"));
  };

  const setLanguage = (language: VoiceLanguage) => {
    prefs.getState().setVoiceLang(language);
    api.voiceSetLanguage(language).catch(warn("could not set the voice language"));
  };

  const setInputDevice = (device: string) => {
    const value = device === "" ? null : device;
    prefs.getState().setVoiceInputDevice(value);
    api.voiceSetInputDevice(value).catch(warn("could not set the input device"));
    if (micTesting) api.voiceTestMicStart(value).catch(warn("could not restart the mic test"));
  };

  const stopMicTest = useCallback(() => {
    setMicTesting(false);
    api.voiceTestMicStop().catch(warn("could not stop the mic test"));
  }, []);

  const toggleMicTest = () => {
    if (micTesting) {
      stopMicTest();
      return;
    }
    api
      .voiceTestMicStart(prefs.getState().voiceInputDevice)
      .then(() => setMicTesting(true))
      .catch((error) => {
        console.error("mic test failed:", error);
        notify(typeof error === "string" ? error : t("app.voice.micTestFailed"));
      });
  };

  const selectModel = (id: string) => {
    api.voiceSetModel(id).catch(handleModelLoadError);
  };

  const downloadModel = (id: string) => {
    setDownload({ id, percent: 0 });
    api.voiceDownloadModel(id).catch((error) => {
      setDownload(null);
      console.error("voice model download failed:", error);
    });
  };

  useEffect(() => {
    const pending = [
      listen<VoiceDownloadProgress>("voice-model-download-progress", (event) =>
        setDownload({ id: event.payload.model_id, percent: event.payload.percent }),
      ),
      listen("voice-model-download-complete", () => {
        setDownload(null);
        refreshModels();
      }),
      listen<string>("voice-model-changed", (event) => {
        prefs.getState().setVoiceModel(event.payload);
        refreshModels();
      }),
      listen<boolean>("voice-mic-changed", (event) => {
        setMicAvailable(event.payload);
        refreshInputDevices();
        if (!event.payload && prefs.getState().voiceEnabled) {
          prefs.getState().setVoiceEnabled(false);
          notify(t("app.voice.micDisconnected"));
        }
      }),
    ];
    return () => {
      for (const unlisten of pending) void unlisten.then((stop) => stop());
    };
  }, [prefs, refreshModels, refreshInputDevices]);

  // Refresh mic presence, models and shells whenever Settings opens. The
  // model list is just files on disk: show it even while voice is off, so a
  // model can be picked and downloaded before turning voice on.
  useEffect(() => {
    if (!settingsOpen) return;
    api.voiceMicAvailable().then(setMicAvailable).catch(warn("could not check the microphone"));
    refreshModels();
    if (voiceEnabled) refreshInputDevices();
    api.listShells().then(setAvailableShells).catch(warn("could not list shells"));
  }, [settingsOpen, voiceEnabled, refreshModels, refreshInputDevices]);

  // A live test stream must not outlive the Voice section, or the mic stays
  // open and blocks real recording.
  useEffect(() => {
    if (voiceSectionOpen) return;
    if (micTesting) stopMicTest();
  }, [voiceSectionOpen, micTesting, stopMicTest]);

  return {
    inputDevices,
    micAvailable,
    micTesting,
    models,
    modelsStatus,
    download,
    availableShells,
    refreshModels,
    applyStoredSettings,
    setEnabled,
    setLanguage,
    setInputDevice,
    toggleMicTest,
    selectModel,
    downloadModel,
  };
}
