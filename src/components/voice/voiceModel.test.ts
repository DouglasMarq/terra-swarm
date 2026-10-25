import { describe, expect, it } from "vitest";

import {
  createInitialVoiceCapsuleModel,
  canExecuteVoiceIntent,
  isDestructiveVoiceIntent,
  reduceVoiceCapsuleModel,
  requiresVoiceConfirmation,
} from "./voiceModel";

describe("voice intent confirmation", () => {
  it("protects suspend-group and stop intents", () => {
    expect(isDestructiveVoiceIntent({ type: "suspend-group", group: "ops" })).toBe(true);
    expect(isDestructiveVoiceIntent({ type: "stop", target: "luna-1" })).toBe(true);
    expect(requiresVoiceConfirmation({ type: "resume-group", group: "ops" })).toBe(false);
    expect(isDestructiveVoiceIntent({ type: "focus", target: "luna-1" })).toBe(false);
    expect(isDestructiveVoiceIntent(null)).toBe(false);
  });

  it("keeps destructive intents blocked until the capsule confirms", () => {
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
  it("moves through capture and transcription into a preview", () => {
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

  it("never completes a destructive preview through send", () => {
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

  it("clears a failed capture on retry and cancel", () => {
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
});
