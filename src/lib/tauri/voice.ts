import type { VoiceModelInfo } from "../../types";
import { invokeCommand } from "./commands";

export function voiceToggleRecording(): Promise<void> {
  return invokeCommand("voiceToggleRecording");
}

export function voiceSetLanguage(language: string): Promise<void> {
  return invokeCommand("voiceSetLanguage", { language });
}

export function voiceMicAvailable(): Promise<boolean> {
  return invokeCommand("voiceMicAvailable");
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

export const voiceApi = {
  voiceToggleRecording,
  voiceSetLanguage,
  voiceMicAvailable,
  voiceListInputDevices,
  voiceSetInputDevice,
  voiceTestMicStart,
  voiceTestMicStop,
  voiceListModels,
  voiceSetModel,
  voiceDownloadModel,
} as const;
