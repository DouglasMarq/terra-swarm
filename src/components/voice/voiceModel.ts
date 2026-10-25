import type { Translate } from "../../i18n";
import type { VoiceIntent } from "../../domain/voiceCommands";

/**
 * Visual states intentionally describe the lifecycle of a voice capture, not
 * its semantic outcome.  The host owns this value so the capsule stays a
 * controlled view component.
 */
export type VoiceCapsuleState =
  | "idle"
  | "listening"
  | "transcribing"
  | "preview"
  | "error";

/**
 * `stop` is kept here as a forward-compatible intent.  The current parser
 * does not emit it yet, but the capsule must still protect it if a host adds
 * the command or receives it from a remote agent.
 */
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

/**
 * Hosts must call this gate immediately before mutating application state.
 * A destructive intent is never executable merely because it was parsed; it
 * needs the explicit confirmation action emitted by the capsule.
 */
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

/**
 * A small pure lifecycle model for hosts that need to coordinate recording,
 * transcription and confirmation.  VoiceCapsule itself remains controlled;
 * this reducer is an optional, testable contract rather than hidden state.
 */
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
