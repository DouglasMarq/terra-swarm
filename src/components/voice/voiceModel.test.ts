import { beforeEach, describe, expect, it } from "vitest";

import { translateNow, useLocaleStore } from "../../i18n";
import {
  createInitialVoiceCapsuleModel,
  canExecuteVoiceIntent,
  isDestructiveVoiceIntent,
  reduceVoiceCapsuleModel,
  requiresVoiceConfirmation,
  voiceIntentLabel,
  voiceStateLabel,
} from "./voiceModel";

beforeEach(() => {
  useLocaleStore.setState({ locale: "en" });
});

describe("voice intent confirmation", () => {
  it("Given suspend-group and stop intents, when checking them, then they are protected", () => {
    expect(isDestructiveVoiceIntent({ type: "suspend-group", group: "ops" })).toBe(true);
    expect(isDestructiveVoiceIntent({ type: "stop", target: "luna-1" })).toBe(true);
    expect(requiresVoiceConfirmation({ type: "resume-group", group: "ops" })).toBe(false);
    expect(isDestructiveVoiceIntent({ type: "focus", target: "luna-1" })).toBe(false);
    expect(isDestructiveVoiceIntent(null)).toBe(false);
  });

  it("Given a destructive intent, when the capsule has not confirmed it, then it stays blocked", () => {
    const suspend = { type: "suspend-group" as const, group: "ops" };
    const stop = { type: "stop" as const, target: "luna-1" };

    expect(canExecuteVoiceIntent(suspend)).toBe(false);
    expect(canExecuteVoiceIntent(stop)).toBe(false);
    expect(canExecuteVoiceIntent(suspend, true)).toBe(true);
    expect(canExecuteVoiceIntent(stop, true)).toBe(true);
    expect(canExecuteVoiceIntent({ type: "open-fleet" })).toBe(true);
  });
});

describe("reduceVoiceCapsuleModel", () => {
  it("Given an idle capsule, when capture and transcription finish, then it moves into a preview", () => {
    const idle = createInitialVoiceCapsuleModel();
    const listening = reduceVoiceCapsuleModel(idle, { type: "start-listening" });
    const transcribing = reduceVoiceCapsuleModel(listening, { type: "stop-listening" });
    const preview = reduceVoiceCapsuleModel(transcribing, {
      type: "transcription-ready",
      transcript: "abrir a frota",
      intent: { type: "open-fleet" },
    });

    expect(listening.state).toBe("listening");
    expect(transcribing.state).toBe("transcribing");
    expect(preview).toMatchObject({
      state: "preview",
      finalTranscript: "abrir a frota",
      isAwaitingConfirmation: false,
    });
  });

  it("Given a destructive preview, when pressing send, then it never completes", () => {
    const preview = reduceVoiceCapsuleModel(createInitialVoiceCapsuleModel(), {
      type: "transcription-ready",
      transcript: "suspender grupo ops",
      intent: { type: "suspend-group", group: "ops" },
    });

    const afterSend = reduceVoiceCapsuleModel(preview, { type: "send" });
    const afterConfirm = reduceVoiceCapsuleModel(afterSend, { type: "confirm" });

    expect(afterSend).toMatchObject({ state: "preview", isAwaitingConfirmation: true });
    expect(afterConfirm).toMatchObject({ state: "idle", isAwaitingConfirmation: false });
  });

  it("Given a failed capture, when retrying or cancelling, then it is cleared", () => {
    const failed = reduceVoiceCapsuleModel(createInitialVoiceCapsuleModel(), {
      type: "fail",
      message: "microphone unavailable",
    });
    const retried = reduceVoiceCapsuleModel(failed, { type: "retry" });
    const cancelled = reduceVoiceCapsuleModel(retried, { type: "cancel" });

    expect(failed).toMatchObject({ state: "error", error: "microphone unavailable" });
    expect(retried).toMatchObject({ state: "listening", error: null });
    expect(cancelled).toEqual(createInitialVoiceCapsuleModel());
  });

  it("Given a capsule outside the expected state, when stopping or retrying, then it is left unchanged", () => {
    const idle = createInitialVoiceCapsuleModel();
    const preview = createInitialVoiceCapsuleModel({ state: "preview", intent: { type: "open-fleet" } });

    expect(reduceVoiceCapsuleModel(idle, { type: "stop-listening" })).toBe(idle);
    expect(reduceVoiceCapsuleModel(idle, { type: "retry" })).toBe(idle);
    expect(reduceVoiceCapsuleModel(preview, { type: "confirm" })).toBe(preview);
  });

  it("Given a capsule, when transcription begins, streams and is sent safely, then it resets after sending", () => {
    const transcribing = reduceVoiceCapsuleModel(createInitialVoiceCapsuleModel(), { type: "begin-transcription" });
    const partial = reduceVoiceCapsuleModel(transcribing, { type: "set-partial-transcript", transcript: "abrir" });
    const preview = reduceVoiceCapsuleModel(partial, { type: "transcription-ready", transcript: "abrir a frota" });
    const destructive = createInitialVoiceCapsuleModel({ state: "preview", intent: { type: "stop" } });

    expect(transcribing.state).toBe("transcribing");
    expect(partial.partialTranscript).toBe("abrir");
    expect(preview.intent).toBeNull();
    expect(reduceVoiceCapsuleModel(preview, { type: "send" })).toEqual(createInitialVoiceCapsuleModel());
    expect(reduceVoiceCapsuleModel(destructive, { type: "confirm" })).toEqual(createInitialVoiceCapsuleModel());
  });
});

describe("voice labels", () => {
  it("Given each intent, when labelling it, then it reads as its action", () => {
    expect(voiceIntentLabel({ type: "focus", target: "luna-1" }, translateNow)).toBe("Focus luna-1");
    expect(voiceIntentLabel({ type: "open-fleet" }, translateNow)).toBe("Open the Fleet");
    expect(voiceIntentLabel({ type: "suspend-group", group: "ops" }, translateNow)).toBe("Suspend group ops");
    expect(voiceIntentLabel({ type: "resume-group", group: "ops" }, translateNow)).toBe("Resume group ops");
    expect(voiceIntentLabel({ type: "new-agent", agent: "codex" }, translateNow)).toBe("Create agent codex");
    expect(voiceIntentLabel({ type: "new-agent" }, translateNow)).toBe("Create a new agent");
    expect(voiceIntentLabel({ type: "stop", target: "luna-1" }, translateNow)).toBe("Stop luna-1");
    expect(voiceIntentLabel({ type: "stop" }, translateNow)).toBe("Stop agent");
  });

  it("Given each capsule state, when labelling it, then it reads as that state", () => {
    expect(voiceStateLabel("idle", translateNow)).toBe("Ready to listen");
    expect(voiceStateLabel("listening", translateNow)).toBe("Listening");
    expect(voiceStateLabel("transcribing", translateNow)).toBe("Transcribing");
    expect(voiceStateLabel("preview", translateNow)).toBe("Preview ready");
    expect(voiceStateLabel("error", translateNow)).toBe("Capture failed");
  });
});
