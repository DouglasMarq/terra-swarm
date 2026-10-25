import type { Translate } from "../../i18n";
import type { VoiceIntent } from "../../domain/voiceCommands";

export type VoiceCapsuleState =
  | "idle"
  | "listening"
  | "transcribing"
  | "preview"
  | "error";

export type VoiceCapsuleIntent = VoiceIntent | { type: "stop"; target?: string };

export interface VoiceSendPayload {
  transcript: string;
  intent: VoiceCapsuleIntent | null;
  agent: string | null;
}

export interface VoiceCapsuleModel {
  state: VoiceCapsuleState;
  partialTranscript: string;
  finalTranscript: string;
  intent: VoiceCapsuleIntent | null;
  error: string | null;
  isAwaitingConfirmation: boolean;
}

export type VoiceCapsuleEvent =
  | { type: "start-listening" }
  | { type: "stop-listening" }
  | { type: "begin-transcription" }
  | {
      type: "transcription-ready";
      transcript: string;
      intent?: VoiceCapsuleIntent | null;
    }
  | { type: "set-partial-transcript"; transcript: string }
  | { type: "fail"; message: string }
  | { type: "cancel" }
  | { type: "send" }
  | { type: "confirm" }
  | { type: "retry" };

export function isDestructiveVoiceIntent(
  intent: VoiceCapsuleIntent | null | undefined,
): boolean {
  return intent?.type === "suspend-group" || intent?.type === "stop";
}

export const requiresVoiceConfirmation = isDestructiveVoiceIntent;

export function canExecuteVoiceIntent(
  intent: VoiceCapsuleIntent | null | undefined,
  isConfirmed = false,
): boolean {
  return Boolean(intent) && (!isDestructiveVoiceIntent(intent) || isConfirmed);
}

export function createInitialVoiceCapsuleModel(
  overrides: Partial<VoiceCapsuleModel> = {},
): VoiceCapsuleModel {
  const model: VoiceCapsuleModel = {
    state: "idle",
    partialTranscript: "",
    finalTranscript: "",
    intent: null,
    error: null,
    isAwaitingConfirmation: false,
  };

  return { ...model, ...overrides };
}

export function reduceVoiceCapsuleModel(
  model: VoiceCapsuleModel,
  event: VoiceCapsuleEvent,
): VoiceCapsuleModel {
  switch (event.type) {
    case "start-listening":
      return {
        ...model,
        state: "listening",
        error: null,
        intent: null,
        partialTranscript: "",
        finalTranscript: "",
        isAwaitingConfirmation: false,
      };
    case "stop-listening":
      return model.state === "listening"
        ? { ...model, state: "transcribing", error: null }
        : model;
    case "begin-transcription":
      return {
        ...model,
        state: "transcribing",
        error: null,
      };
    case "set-partial-transcript":
      return { ...model, partialTranscript: event.transcript };
    case "transcription-ready": {
      const intent = event.intent ?? null;
      return {
        ...model,
        state: "preview",
        finalTranscript: event.transcript,
        partialTranscript: event.transcript,
        intent,
        error: null,
        isAwaitingConfirmation: isDestructiveVoiceIntent(intent),
      };
    }
    case "fail":
      return {
        ...model,
        state: "error",
        error: event.message,
        isAwaitingConfirmation: false,
      };
    case "cancel":
      return createInitialVoiceCapsuleModel();
    case "send":
      return isDestructiveVoiceIntent(model.intent) || model.isAwaitingConfirmation
        ? { ...model, isAwaitingConfirmation: true }
        : createInitialVoiceCapsuleModel();
    case "confirm":
      return isDestructiveVoiceIntent(model.intent)
        ? createInitialVoiceCapsuleModel()
        : model;
    case "retry":
      return model.state === "error"
        ? { ...model, state: "listening", error: null }
        : model;
  }
}

export function voiceIntentLabel(intent: VoiceCapsuleIntent, translate: Translate): string {
  switch (intent.type) {
    case "focus":
      return translate("voiceIntent.focus", { name: intent.target });
    case "open-fleet":
      return translate("palette.openFleet");
    case "suspend-group":
      return translate("voiceIntent.suspendGroup", { name: intent.group });
    case "resume-group":
      return translate("voiceIntent.resumeGroup", { name: intent.group });
    case "new-agent":
      return intent.agent ? translate("voiceIntent.newAgentNamed", { name: intent.agent }) : translate("voiceIntent.newAgent");
    case "stop":
      return intent.target ? translate("voiceIntent.stopNamed", { name: intent.target }) : translate("voiceIntent.stop");
  }
}

export function voiceStateLabel(state: VoiceCapsuleState, translate: Translate): string {
  switch (state) {
    case "idle":
      return translate("voiceState.idle");
    case "listening":
      return translate("shell.voiceListening");
    case "transcribing":
      return translate("shell.voiceTranscribing");
    case "preview":
      return translate("voiceState.preview");
    case "error":
      return translate("voiceState.error");
  }
}
