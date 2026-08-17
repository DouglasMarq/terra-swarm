import type { VoiceIntent } from "../../lib/voiceCommands";

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

export interface VoiceCapsuleModel {
  state: VoiceCapsuleState;
  partialTranscript: string;
  finalTranscript: string;
  intent: VoiceCapsuleIntent | null;
  error: string | null;
  awaitingConfirmation: boolean;
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
  confirmed = false,
): boolean {
  return Boolean(intent) && (!isDestructiveVoiceIntent(intent) || confirmed);
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
    awaitingConfirmation: false,
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
        awaitingConfirmation: false,
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
        awaitingConfirmation: isDestructiveVoiceIntent(intent),
      };
    }
    case "fail":
      return {
        ...model,
        state: "error",
        error: event.message,
        awaitingConfirmation: false,
      };
    case "cancel":
      return createInitialVoiceCapsuleModel();
    case "send":
      return isDestructiveVoiceIntent(model.intent) || model.awaitingConfirmation
        ? { ...model, awaitingConfirmation: true }
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

export function voiceIntentLabel(intent: VoiceCapsuleIntent): string {
  switch (intent.type) {
    case "focus":
      return `Focar em ${intent.target}`;
    case "open-fleet":
      return "Abrir frota";
    case "suspend-group":
      return `Suspender grupo ${intent.group}`;
    case "resume-group":
      return `Retomar grupo ${intent.group}`;
    case "new-agent":
      return intent.agent ? `Criar agente ${intent.agent}` : "Criar novo agente";
    case "stop":
      return intent.target ? `Parar ${intent.target}` : "Parar agente";
  }
}

export function voiceStateLabel(state: VoiceCapsuleState): string {
  switch (state) {
    case "idle":
      return "Pronto para ouvir";
    case "listening":
      return "Ouvindo";
    case "transcribing":
      return "Transcrevendo";
    case "preview":
      return "Prévia pronta";
    case "error":
      return "Falha na captura";
  }
}
