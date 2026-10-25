import type { VoiceDownloadProgress, VoiceModelInfo } from "../../domain/voice.model";
import { invokeCommand } from "./commands";
import { listenPayload, type UnlistenFn } from "./events";

export function voiceToggleRecording(): Promise<void> {
  return invokeCommand("voiceToggleRecording");
}

export function voiceSetLanguage(language: string): Promise<void> {
  return invokeCommand("voiceSetLanguage", { language });
}

export function voiceIsMicAvailable(): Promise<boolean> {
  return invokeCommand("voiceIsMicAvailable");
}

export function voiceListInputDevices(): Promise<string[]> {
  return invokeCommand("voiceListInputDevices");
}

export function voiceSetInputDevice(device: string | null): Promise<void> {
  return invokeCommand("voiceSetInputDevice", { device });
}

export function voiceTestMicStart(device: string | null): Promise<void> {
  return invokeCommand("voiceTestMicStart", { device });
}

export function voiceTestMicStop(): Promise<void> {
  return invokeCommand("voiceTestMicStop");
}

export function voiceListModels(): Promise<VoiceModelInfo[]> {
  return invokeCommand("voiceListModels");
}

export function voiceSetModel(modelId: string): Promise<void> {
  return invokeCommand("voiceSetModel", { modelId });
}

export function voiceDownloadModel(modelId: string): Promise<void> {
  return invokeCommand("voiceDownloadModel", { modelId });
}

export function onVoiceRecordingStarted(handler: () => void): Promise<UnlistenFn> {
  return listenPayload("voice-recording-started", handler);
}

export function onVoiceRecordingStopped(handler: () => void): Promise<UnlistenFn> {
  return listenPayload("voice-recording-stopped", handler);
}

export function onVoiceRecordingError(handler: (message: string) => void): Promise<UnlistenFn> {
  return listenPayload("voice-recording-error", handler);
}

export function onVoiceAudioLevel(handler: (level: number) => void): Promise<UnlistenFn> {
  return listenPayload("voice-audio-level", handler);
}

export function onVoiceTranscriptionStarted(handler: () => void): Promise<UnlistenFn> {
  return listenPayload("voice-transcription-started", handler);
}

export function onVoiceTranscriptionComplete(handler: (transcript: string) => void): Promise<UnlistenFn> {
  return listenPayload("voice-transcription-complete", handler);
}

export function onVoiceTranscriptionError(handler: (message: string) => void): Promise<UnlistenFn> {
  return listenPayload("voice-transcription-error", handler);
}

export function onVoiceModelDownloadProgress(handler: (progress: VoiceDownloadProgress) => void): Promise<UnlistenFn> {
  return listenPayload("voice-model-download-progress", handler);
}

export function onVoiceModelDownloadComplete(handler: () => void): Promise<UnlistenFn> {
  return listenPayload("voice-model-download-complete", handler);
}

export function onVoiceModelChanged(handler: (modelId: string) => void): Promise<UnlistenFn> {
  return listenPayload("voice-model-changed", handler);
}

export function onVoiceMicChanged(handler: (isAvailable: boolean) => void): Promise<UnlistenFn> {
  return listenPayload("voice-mic-changed", handler);
}

export const voiceApi = {
  voiceToggleRecording,
  voiceSetLanguage,
  voiceIsMicAvailable,
  voiceListInputDevices,
  voiceSetInputDevice,
  voiceTestMicStart,
  voiceTestMicStop,
  voiceListModels,
  voiceSetModel,
  voiceDownloadModel,
} as const;
