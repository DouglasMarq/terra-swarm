import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import {
  onVoiceMicChanged,
  onVoiceModelChanged,
  onVoiceModelDownloadComplete,
  onVoiceModelDownloadProgress,
} from "../lib/tauri/voice";
import type { VoiceModelInfo } from "../domain/voice.model";
import { translateNow } from "../i18n";
import { usePreferencesStore } from "../stores/preferencesStore";
import type { VoiceLanguage } from "../domain/voiceLanguages";
import { useTerminalRuntimeStore } from "../stores/terminalRuntimeStore";

const warn = (what: string) => (error: unknown) => console.warn(`${what}:`, error);

interface VoiceSettingsInput {
  isSettingsOpen: boolean;
  isVoiceSectionOpen: boolean;
}

export function useVoiceSettings({ isSettingsOpen, isVoiceSectionOpen }: VoiceSettingsInput) {
  const prefs = usePreferencesStore;
  const isVoiceEnabled = usePreferencesStore((state) => state.isVoiceEnabled);
  const [inputDevices, setInputDevices] = useState<string[]>([]);
  const [isMicAvailable, setMicAvailable] = useState<boolean | null>(null);
  const [isMicTesting, setMicTesting] = useState(false);
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
    notify(translateNow("app.voice.modelLoadFailed"));
  };

  const disableVoice = (shouldAnnounce: boolean) => {
    prefs.getState().setVoiceEnabled(false);
    if (shouldAnnounce) notify(translateNow("app.voice.micDisconnected"));
  };

  const pushStoredSettings = () => {
    const { voiceLang, voiceInputDevice, voiceModel } = prefs.getState();
    api.voiceSetLanguage(voiceLang).catch(warn("could not set the voice language"));
    api.voiceSetInputDevice(voiceInputDevice).catch(warn("could not set the input device"));
    if (voiceModel) api.voiceSetModel(voiceModel).catch(handleModelLoadError);
  };

  const applyStoredSettings = () => {
    if (!prefs.getState().isVoiceEnabled) return;
    api
      .voiceIsMicAvailable()
      .then((isAvailable) => {
        setMicAvailable(isAvailable);
        if (!isAvailable) disableVoice(false);
      })
      .catch(warn("could not check the microphone"));
    pushStoredSettings();
  };

  const setEnabled = (isOn: boolean) => {
    if (!isOn) {
      prefs.getState().setVoiceEnabled(false);
      return;
    }
    api
      .voiceIsMicAvailable()
      .then((isAvailable) => {
        setMicAvailable(isAvailable);
        if (!isAvailable) return;
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
    if (isMicTesting) api.voiceTestMicStart(value).catch(warn("could not restart the mic test"));
  };

  const stopMicTest = useCallback(() => {
    setMicTesting(false);
    api.voiceTestMicStop().catch(warn("could not stop the mic test"));
  }, []);

  const toggleMicTest = () => {
    if (isMicTesting) {
      stopMicTest();
      return;
    }
    api
      .voiceTestMicStart(prefs.getState().voiceInputDevice)
      .then(() => setMicTesting(true))
      .catch((error) => {
        console.error("mic test failed:", error);
        notify(typeof error === "string" ? error : translateNow("app.voice.micTestFailed"));
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
      onVoiceModelDownloadProgress((progress) =>
        setDownload({ id: progress.model_id, percent: progress.percent }),
      ),
      onVoiceModelDownloadComplete(() => {
        setDownload(null);
        refreshModels();
      }),
      onVoiceModelChanged((modelId) => {
        prefs.getState().setVoiceModel(modelId);
        refreshModels();
      }),
      onVoiceMicChanged((isAvailable) => {
        setMicAvailable(isAvailable);
        refreshInputDevices();
        if (!isAvailable && prefs.getState().isVoiceEnabled) {
          prefs.getState().setVoiceEnabled(false);
          notify(translateNow("app.voice.micDisconnected"));
        }
      }),
    ];
    return () => {
      for (const unlisten of pending) void unlisten.then((stop) => stop());
    };
  }, [prefs, refreshModels, refreshInputDevices]);

  useEffect(() => {
    if (!isSettingsOpen) return;
    api.voiceIsMicAvailable().then(setMicAvailable).catch(warn("could not check the microphone"));
    refreshModels();
    if (isVoiceEnabled) refreshInputDevices();
    api.listShells().then(setAvailableShells).catch(warn("could not list shells"));
  }, [isSettingsOpen, isVoiceEnabled, refreshModels, refreshInputDevices]);

  useEffect(() => {
    if (isVoiceSectionOpen) return;
    if (isMicTesting) stopMicTest();
  }, [isVoiceSectionOpen, isMicTesting, stopMicTest]);

  return {
    inputDevices,
    isMicAvailable,
    isMicTesting,
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
