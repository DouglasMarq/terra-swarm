import { describe, expect, it } from "vitest";

import {
  createInitialVoiceCapsuleModel,
  canExecuteVoiceIntent,
  isDestructiveVoiceIntent,
  reduceVoiceCapsuleModel,
  requiresVoiceConfirmation,
} from "./voiceModel";

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
});
