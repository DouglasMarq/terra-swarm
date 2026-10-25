import { useCallback, useEffect, useEffectEvent, useReducer, useRef, useState } from "react";
import { api } from "../api";
import {
  onVoiceAudioLevel,
  onVoiceRecordingError,
  onVoiceRecordingStarted,
  onVoiceRecordingStopped,
  onVoiceTranscriptionComplete,
  onVoiceTranscriptionError,
  onVoiceTranscriptionStarted,
} from "../lib/tauri/voice";
import type { AgentInfo } from "../domain/agent.model";
import type { VoiceStatus } from "../domain/voice.model";
import type { Workspace, WorkspaceGroup } from "../domain/workspace.model";
import {
  createInitialVoiceCapsuleModel,
  canExecuteVoiceIntent,
  isDestructiveVoiceIntent,
  reduceVoiceCapsuleModel,
  type VoiceCapsuleIntent,
  type VoiceSendPayload,
} from "../components/voice/voiceModel";
import { getTerminal } from "../terminalRegistry";
import { translateNow } from "../i18n";
import { agentLabelText, buildAgentLabels } from "../domain/agentLabels";
import { orchestratorOf } from "../domain/agentRoles";
import { parseVoiceCommand } from "../domain/voiceCommands";
import { isVoiceModelError, resolveVoiceAgent, resolveVoiceGroup, resolveVoiceTerminal } from "../domain/voiceTargets";
import { promptPayload } from "../domain/session/sendPrompt";
import { buildVoicePrompt, profileForCommand, resolveResumeCommand } from "../domain/agentProfiles";
import { usePreferencesStore } from "../stores/preferencesStore";
import { useOrchestrationStore } from "../stores/orchestrationStore";
import { useShellStore } from "../stores/shellStore";
import { useTerminalRuntimeStore } from "../stores/terminalRuntimeStore";
import { useUiStore } from "../stores/uiStore";
import type { TerminalSessions } from "./useTerminalSessions";

const RESUMED_AGENT_PROMPT_DELAY_MS = 1500;

const VOICE_WAVEFORM_SAMPLES = 32;

interface VoiceCaptureInput {
  workspaces: Workspace[];
  groups: readonly WorkspaceGroup[];
  agents: readonly AgentInfo[];
  activeWorkspace: Workspace | null;
  focusedId: string | null;
  titles: Record<string, string>;
  isVoiceEnabled: boolean;
  isVoiceCommandsEnabled: boolean;
  sessions: Pick<TerminalSessions, "spawnInto" | "close" | "restart">;
  openVoiceSettings: () => void;
  actions: {
    quickNewTerminal: (workspaceId: string) => Promise<void>;
    selectWorkspace: (workspaceId: string) => void;
    suspendGroup: (groupId: string) => Promise<void>;
    resumeGroup: (groupId: string) => Promise<void>;
  };
}

export function useVoiceCapture({
  workspaces,
  groups,
  agents,
  activeWorkspace,
  focusedId,
  titles,
  isVoiceEnabled,
  isVoiceCommandsEnabled,
  sessions,
  openVoiceSettings,
  actions,
}: VoiceCaptureInput) {
  const notify = (message: string) => useTerminalRuntimeStore.getState().pushSystemNotification(message);
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>("idle");
  const [voiceCapsule, dispatchVoiceCapsule] = useReducer(
    reduceVoiceCapsuleModel,
    undefined,
    createInitialVoiceCapsuleModel,
  );
  const [voiceLevel, setVoiceLevel] = useState(0);
  const [voiceSamples, setVoiceSamples] = useState<number[]>([]);
  const [voiceFeedback, setVoiceFeedback] = useState<string | null>(null);
  const [isVoiceSubmitted, setVoiceSubmitted] = useState(false);

  const voiceTerminalFor = (target: string) =>
    resolveVoiceTerminal(workspaces, target, { titles, names: usePreferencesStore.getState().agentNames });

  const focusVoiceTarget = (target: string): boolean => {
    const match = voiceTerminalFor(target);
    if (!match) return false;
    useOrchestrationStore.getState().reattachTerminal(match.terminal.id);
    actions.selectWorkspace(match.workspace.id);
    useUiStore.getState().setFocusedId(match.terminal.id);
    return true;
  };

  const targetLabelForVoiceIntent = (intent: VoiceCapsuleIntent | null): string | null => {
    if (!intent) {
      const id = defaultTargetId;
      if (!id) return null;
      const label = buildAgentLabels(workspaces, { titles, names: usePreferencesStore.getState().agentNames })[id];
      return label ? agentLabelText(label) : id;
    }
    switch (intent.type) {
      case "focus":
      case "stop":
        return intent.target ?? null;
      case "suspend-group":
      case "resume-group":
        return intent.group;
      case "new-agent":
        return intent.agent ?? translateNow("app.defaultAgent");
      case "open-fleet":
        return translateNow("app.voice.fleet");
    }
  };

  const startVoiceAgent = async (agentTarget?: string) => {
    if (!activeWorkspace) {
      notify(translateNow("app.pickWorkspaceFirst"));
      return;
    }
    if (!agentTarget) {
      await actions.quickNewTerminal(activeWorkspace.id);
      return;
    }
    const agent = resolveVoiceAgent(agents, agentTarget);
    if (!agent) {
      notify(translateNow("app.agentUnavailable", { name: agentTarget }));
      return;
    }
    await sessions.spawnInto(activeWorkspace.id, agent.id);
  };

  const runVoiceGroupAction = async (
    groupName: string,
    action: (groupId: string) => Promise<void>,
    doneKey: "app.voice.groupSuspended" | "app.voice.groupResumed",
  ): Promise<boolean> => {
    const groupId = resolveVoiceGroup(groups, groupName);
    if (!groupId) {
      notify(translateNow("app.voice.groupNotFound", { name: groupName }));
      setVoiceFeedback(translateNow("app.voice.groupNotFound", { name: groupName }));
      return false;
    }
    await action(groupId);
    setVoiceFeedback(translateNow(doneKey, { name: groupName }));
    return true;
  };

  const executeVoiceIntent = async (
    intent: VoiceCapsuleIntent,
    isConfirmed = false,
  ): Promise<boolean> => {
    if (!canExecuteVoiceIntent(intent, isConfirmed)) {
      setVoiceFeedback(translateNow("app.voice.confirmDestructive"));
      return false;
    }
    try {
      switch (intent.type) {
        case "open-fleet":
          useShellStore.getState().navigate("fleet");
          setVoiceFeedback(translateNow("app.voice.fleetOpened"));
          return true;
        case "focus":
          if (!focusVoiceTarget(intent.target)) {
            notify(translateNow("app.voice.terminalNotFound", { name: intent.target }));
            setVoiceFeedback(translateNow("app.voice.terminalNotFound", { name: intent.target }));
            return false;
          }
          setVoiceFeedback(translateNow("app.voice.focusChanged", { name: intent.target }));
          return true;
        case "suspend-group":
          return await runVoiceGroupAction(intent.group, actions.suspendGroup, "app.voice.groupSuspended");
        case "resume-group":
          return await runVoiceGroupAction(intent.group, actions.resumeGroup, "app.voice.groupResumed");
        case "new-agent":
          await startVoiceAgent(intent.agent);
          setVoiceFeedback(intent.agent ? translateNow("app.voice.agentStarted", { name: intent.agent }) : translateNow("app.voice.agentReady"));
          return true;
        case "stop": {
          const match = intent.target ? voiceTerminalFor(intent.target) : null;
          if (!match) {
            setVoiceFeedback(intent.target ? translateNow("app.voice.terminalNotFound", { name: intent.target }) : translateNow("app.voice.whichStop"));
            return false;
          }
          await sessions.close(match.terminal.id);
          setVoiceFeedback(translateNow("app.voice.terminalStopped", { name: intent.target }));
          return true;
        }
      }
    } catch (err) {
      console.error("voice orchestration command failed:", err);
      setVoiceFeedback(translateNow("app.voice.actionFailed"));
      notify(translateNow("app.voice.actionFailed"));
      return false;
    }
  };


  const toggleVoice = useCallback(() => {
    if (!isVoiceEnabled) {
      openVoiceSettings();
      return;
    }
    api
      .voiceToggleRecording()
      .catch((err) => console.error("voice toggle failed:", err));
  }, [isVoiceEnabled, openVoiceSettings]);

  const voiceFocusRef = useRef<string | null>(null);
  const [voiceTargetId, setVoiceTargetId] = useState<string | null>(null);
  const shouldSendVoiceToOrchestrator = usePreferencesStore((state) => state.shouldSendVoiceToOrchestrator);
  const exitedTerminals = useTerminalRuntimeStore((state) => state.exited);
  const orchestratorId = shouldSendVoiceToOrchestrator ? orchestratorOf(activeWorkspace, exitedTerminals) : null;
  const defaultTargetId = voiceTargetId ?? orchestratorId ?? focusedId;
  voiceFocusRef.current = defaultTargetId;

  const deliverDictation = async (id: string, text: string): Promise<void> => {
    const meta = workspaces.flatMap((workspace) => workspace.terminals).find((candidate) => candidate.id === id);
    if (meta && id in useTerminalRuntimeStore.getState().exited) {
      setVoiceFeedback(translateNow("app.voice.resuming"));
      await sessions.restart(id, resolveResumeCommand(profileForCommand(meta.command), meta.command));
      await new Promise((resolve) => setTimeout(resolve, RESUMED_AGENT_PROMPT_DELAY_MS));
    }
    const term = getTerminal(id);
    if (!term && !meta) {
      setVoiceFeedback(translateNow("app.voice.targetUnavailable"));
      return;
    }
    const profile = meta ? profileForCommand(meta.command) : null;
    const prompt = voiceCommandsEnabledRef.current && profile
      ? buildVoicePrompt(profile, text)
      : text;
    const isBracketed = term ? term.modes.bracketedPasteMode : profile?.id !== "shell";
    try {
      await api.writeTerminal(id, promptPayload(prompt, isBracketed));
      term?.focus();
      setVoiceSubmitted(true);
      setVoiceFeedback(translateNow("app.voice.sent"));
    } catch (error) {
      console.error("voice dictation write failed:", error);
      dispatchVoiceCapsule({ type: "fail", message: translateNow("app.voice.sendFailed") });
      setVoiceFeedback(translateNow("app.voice.sendFailed"));
    }
  };
  const deliverDictationRef = useRef(deliverDictation);
  deliverDictationRef.current = deliverDictation;

  useEffect(() => {
    if (voiceCapsule.state === "idle") setVoiceTargetId(null);
  }, [voiceCapsule.state]);
  const voiceCommandsEnabledRef = useRef(isVoiceCommandsEnabled);
  voiceCommandsEnabledRef.current = isVoiceCommandsEnabled;

  const openVoiceSettingsFromEvent = useEffectEvent(() => openVoiceSettings());

  useEffect(() => {
    const unRecStart = onVoiceRecordingStarted(() => {
      setVoiceStatus("recording");
      setVoiceFeedback(null);
      setVoiceSubmitted(false);
      setVoiceLevel(0);
      setVoiceSamples([]);
      dispatchVoiceCapsule({ type: "start-listening" });
    });
    const unRecStop = onVoiceRecordingStopped(() => {
      setVoiceStatus("transcribing");
      dispatchVoiceCapsule({ type: "stop-listening" });
    });
    const unAudioLevel = onVoiceAudioLevel((payload) => {
      const level = Math.max(0, Math.min(1, Number(payload) || 0));
      setVoiceLevel(level);
      setVoiceSamples((previous) => [...previous.slice(-(VOICE_WAVEFORM_SAMPLES - 1)), level]);
    });
    const unTrStart = onVoiceTranscriptionStarted(() => {
      setVoiceStatus("transcribing");
      dispatchVoiceCapsule({ type: "begin-transcription" });
    });
    const unTrDone = onVoiceTranscriptionComplete((transcript) => {
      setVoiceStatus("idle");
      const text = transcript.trim();
      if (!text) {
        dispatchVoiceCapsule({ type: "transcription-ready", transcript: "", intent: null });
        setVoiceFeedback(translateNow("app.voice.noTranscript"));
        return;
      }
      if (voiceCommandsEnabledRef.current) {
        const intent = parseVoiceCommand(text);
        if (intent) {
          dispatchVoiceCapsule({ type: "transcription-ready", transcript: text, intent });
          setVoiceSubmitted(false);
          setVoiceFeedback(isDestructiveVoiceIntent(intent)
            ? translateNow("app.voice.reviewDestructive")
            : translateNow("app.voice.reviewIntent"));
          return;
        }
      }

      dispatchVoiceCapsule({ type: "transcription-ready", transcript: text, intent: null });
      setVoiceSubmitted(false);
      const id = voiceFocusRef.current;
      if (!id) {
        setVoiceFeedback(translateNow("app.voice.readyPickTarget"));
        return;
      }
      void deliverDictationRef.current(id, text);
    });
    const reportVoiceFailure = (message: string, fallback: string, logLabel: string): void => {
      setVoiceStatus("idle");
      dispatchVoiceCapsule({ type: "fail", message: message || fallback });
      setVoiceFeedback(message || fallback);
      console.error(logLabel, message);
      if (isVoiceModelError(message)) openVoiceSettingsFromEvent();
    };
    const unTrErr = onVoiceTranscriptionError((message) =>
      reportVoiceFailure(message, translateNow("app.voice.transcriptionFailed"), "voice transcription error:"),
    );
    const unRecErr = onVoiceRecordingError((message) =>
      reportVoiceFailure(message, translateNow("app.voice.captureFailed"), "voice recording error:"),
    );
    return () => {
      unRecStart.then((unlisten) => unlisten());
      unRecStop.then((unlisten) => unlisten());
      unAudioLevel.then((unlisten) => unlisten());
      unTrStart.then((unlisten) => unlisten());
      unTrDone.then((unlisten) => unlisten());
      unTrErr.then((unlisten) => unlisten());
      unRecErr.then((unlisten) => unlisten());
    };
  }, [workspaces]);


  const startVoiceCapture = () => {
    if (!isVoiceEnabled) {
      toggleVoice();
      return;
    }
    api.voiceToggleRecording().catch((error) => {
      console.error("voice start failed:", error);
      setVoiceFeedback(translateNow("app.voice.startFailed"));
    });
  };

  const stopVoiceCapture = () => {
    if (voiceStatus !== "recording") return;
    api.voiceToggleRecording().catch((error) => {
      console.error("voice stop failed:", error);
      setVoiceFeedback(translateNow("app.voice.stopFailed"));
    });
  };

  const cancelVoiceCapture = () => {
    if (voiceStatus === "recording") {
      api.voiceToggleRecording().catch((error) => console.warn("could not stop the recording:", error));
    }
    dispatchVoiceCapsule({ type: "cancel" });
    setVoiceStatus("idle");
    setVoiceSubmitted(false);
    setVoiceFeedback(null);
    setVoiceLevel(0);
    setVoiceSamples([]);
  };

  const retryVoiceCapture = () => {
    if (!isVoiceEnabled) {
      toggleVoice();
      return;
    }
    dispatchVoiceCapsule({ type: "retry" });
    setVoiceSubmitted(false);
    setVoiceFeedback(null);
    api.voiceToggleRecording().catch((error) => {
      console.error("voice retry failed:", error);
      dispatchVoiceCapsule({ type: "fail", message: translateNow("app.voice.retryFailed") });
      setVoiceFeedback(translateNow("app.voice.retryFailed"));
    });
  };

  const sendVoicePayload = async (payload: VoiceSendPayload, isConfirmed: boolean) => {
    if (payload.intent) {
      const hasSucceeded = await executeVoiceIntent(payload.intent, isConfirmed);
      if (hasSucceeded) setVoiceSubmitted(true);
      return;
    }

    const id = voiceFocusRef.current;
    if (!id) {
      setVoiceFeedback(translateNow("app.voice.pickTarget"));
      return;
    }
    await deliverDictation(id, payload.transcript);
  };

  return {
    status: voiceStatus,
    capsule: voiceCapsule,
    level: voiceLevel,
    samples: voiceSamples,
    feedback: voiceFeedback,
    isSubmitted: isVoiceSubmitted,
    targetId: defaultTargetId,
    setTargetId: setVoiceTargetId,
    targetLabel: targetLabelForVoiceIntent(voiceCapsule.intent),
    toggle: toggleVoice,
    start: startVoiceCapture,
    stop: stopVoiceCapture,
    cancel: cancelVoiceCapture,
    retry: retryVoiceCapture,
    send: sendVoicePayload,
  };
}
