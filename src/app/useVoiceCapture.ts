import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "../api";
import type { AgentInfo, VoiceStatus, Workspace, WorkspaceGroup } from "../types";
import {
  createInitialVoiceCapsuleModel,
  canExecuteVoiceIntent,
  isDestructiveVoiceIntent,
  reduceVoiceCapsuleModel,
  type VoiceCapsuleIntent,
  type VoiceSendPayload,
} from "../components/voice/voiceModel";
import { getTerminal } from "../terminalRegistry";
import { t } from "../i18n";
import { agentKind, agentLabelText, buildAgentLabels } from "../domain/agentLabels";
import { orchestratorOf } from "../domain/agentRoles";
import { normalizeVoiceText, parseVoiceCommand } from "../lib/voiceCommands";
import { promptPayload } from "../lib/session/sendPrompt";
import { buildVoicePrompt, profileForCommand, resolveResumeCommand } from "../lib/features/agentProfiles";
import { usePreferencesStore } from "../stores/preferencesStore";
import { useOrchestrationStore } from "../stores/orchestrationStore";
import { useShellStore } from "../stores/shellStore";
import { useTerminalRuntimeStore } from "../stores/terminalRuntimeStore";
import { useUiStore } from "../stores/uiStore";
import type { TerminalSessions } from "./useTerminalSessions";

/** Time a resumed agent's CLI gets to draw its prompt before dictation is pasted. */
const RESUMED_AGENT_PROMPT_DELAY_MS = 1500;

/** Audio levels kept for the capsule's waveform. */
const VOICE_WAVEFORM_SAMPLES = 32;

interface VoiceCaptureInput {
  workspaces: Workspace[];
  groups: readonly WorkspaceGroup[];
  agents: readonly AgentInfo[];
  activeWorkspace: Workspace | null;
  focusedId: string | null;
  titles: Record<string, string>;
  voiceEnabled: boolean;
  /** Parse spoken commands ("foca no claude 2") instead of only dictating. */
  voiceCommandsEnabled: boolean;
  sessions: TerminalSessions;
  openVoiceSettings: () => void;
  actions: {
    quickNewTerminal: (workspaceId: string) => Promise<void>;
    selectWorkspace: (workspaceId: string) => void;
    suspendGroup: (groupId: string) => Promise<void>;
    resumeGroup: (groupId: string) => Promise<void>;
  };
}

/**
 * Voice capture from the capsule: recording state, transcription events,
 * delivering dictation to an agent (resuming it first if it exited) and
 * running parsed voice commands after an explicit Send/Confirm.
 */
export function useVoiceCapture({
  workspaces,
  groups,
  agents,
  activeWorkspace,
  focusedId,
  titles,
  voiceEnabled,
  voiceCommandsEnabled,
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
  const [voiceSubmitted, setVoiceSubmitted] = useState(false);

  const resolveVoiceTerminal = (target: string) => {
    const needle = normalizeVoiceText(target);
    if (!needle) return null;
    const labels = buildAgentLabels(workspaces, { titles, names: usePreferencesStore.getState().agentNames });
    for (const workspace of workspaces) {
      const terminal = workspace.terminals.find((candidate) => {
        const title = titles[candidate.id] ?? "";
        const command = candidate.command.trim();
        const label = labels[candidate.id];
        // Exact: id, raw title, command, kind, numbered tag ("claude 2"),
        // task title or given name.
        return [candidate.id, title, command, agentKind(command), label?.tag ?? "", label?.title ?? "", label?.name ?? ""]
          .some((value) => value && normalizeVoiceText(value) === needle);
      });
      if (terminal) return { workspace, terminal };
    }
    // Loose: the spoken words appear in the task title ("o claude das animações").
    for (const workspace of workspaces) {
      const terminal = workspace.terminals.find((candidate) => {
        const title = labels[candidate.id]?.title;
        return title ? normalizeVoiceText(title).includes(needle) || needle.includes(normalizeVoiceText(title)) : false;
      });
      if (terminal) return { workspace, terminal };
    }
    const workspace = workspaces.find(
      (candidate) =>
        normalizeVoiceText(candidate.id) === needle ||
        normalizeVoiceText(candidate.name) === needle,
    );
    const terminal = workspace?.terminals[0];
    return workspace && terminal ? { workspace, terminal } : null;
  };

  const focusVoiceTarget = (target: string): boolean => {
    const match = resolveVoiceTerminal(target);
    if (!match) return false;
    useOrchestrationStore.getState().reattachTerminal(match.terminal.id);
    actions.selectWorkspace(match.workspace.id);
    useUiStore.getState().setFocusedId(match.terminal.id);
    return true;
  };

  const targetLabelForVoiceIntent = (intent: VoiceCapsuleIntent | null): string | null => {
    if (!intent) {
      // The picker's choice, else the focused agent, as the readable label.
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
        return intent.agent ?? t("app.defaultAgent");
      case "open-fleet":
        return t("app.voice.fleet");
    }
  };

  const resolveVoiceGroup = (target: string): string | null => {
    const needle = normalizeVoiceText(target);
    return groups.find(
      (group) =>
        normalizeVoiceText(group.id) === needle ||
        normalizeVoiceText(group.name) === needle,
    )?.id ?? null;
  };

  const startVoiceAgent = async (agentTarget?: string) => {
    if (!activeWorkspace) {
      notify(t("app.pickWorkspaceFirst"));
      return;
    }
    if (!agentTarget) {
      await actions.quickNewTerminal(activeWorkspace.id);
      return;
    }
    const needle = normalizeVoiceText(agentTarget);
    const agent = agents.find(
      (candidate) =>
        candidate.available &&
        (normalizeVoiceText(candidate.id) === needle ||
          normalizeVoiceText(candidate.label) === needle),
    );
    if (!agent) {
      notify(t("app.agentUnavailable", { name: agentTarget }));
      return;
    }
    await sessions.spawnInto(activeWorkspace.id, agent.id);
  };

  const executeVoiceIntent = async (
    intent: VoiceCapsuleIntent,
    confirmed = false,
  ): Promise<boolean> => {
    if (!canExecuteVoiceIntent(intent, confirmed)) {
      setVoiceFeedback(t("app.voice.confirmDestructive"));
      return false;
    }
    try {
      switch (intent.type) {
        case "open-fleet":
          useShellStore.getState().navigate("fleet");
          setVoiceFeedback(t("app.voice.fleetOpened"));
          return true;
        case "focus":
          if (!focusVoiceTarget(intent.target)) {
            notify(t("app.voice.terminalNotFound", { name: intent.target }));
            setVoiceFeedback(t("app.voice.terminalNotFound", { name: intent.target }));
            return false;
          }
          setVoiceFeedback(t("app.voice.focusChanged", { name: intent.target }));
          return true;
        case "suspend-group": {
          const groupId = resolveVoiceGroup(intent.group);
          if (!groupId) {
            notify(t("app.voice.groupNotFound", { name: intent.group }));
            setVoiceFeedback(t("app.voice.groupNotFound", { name: intent.group }));
            return false;
          }
          await actions.suspendGroup(groupId);
          setVoiceFeedback(t("app.voice.groupSuspended", { name: intent.group }));
          return true;
        }
        case "resume-group": {
          const groupId = resolveVoiceGroup(intent.group);
          if (!groupId) {
            notify(t("app.voice.groupNotFound", { name: intent.group }));
            setVoiceFeedback(t("app.voice.groupNotFound", { name: intent.group }));
            return false;
          }
          await actions.resumeGroup(groupId);
          setVoiceFeedback(t("app.voice.groupResumed", { name: intent.group }));
          return true;
        }
        case "new-agent":
          await startVoiceAgent(intent.agent);
          setVoiceFeedback(intent.agent ? t("app.voice.agentStarted", { name: intent.agent }) : t("app.voice.agentReady"));
          return true;
        case "stop": {
          const match = intent.target ? resolveVoiceTerminal(intent.target) : null;
          if (!match) {
            setVoiceFeedback(intent.target ? t("app.voice.terminalNotFound", { name: intent.target }) : t("app.voice.whichStop"));
            return false;
          }
          await sessions.close(match.terminal.id);
          setVoiceFeedback(t("app.voice.terminalStopped", { name: intent.target }));
          return true;
        }
      }
    } catch (err) {
      console.error("voice orchestration command failed:", err);
      setVoiceFeedback(t("app.voice.actionFailed"));
      notify(t("app.voice.actionFailed"));
      return false;
    }
  };


  const toggleVoice = useCallback(() => {
    if (!voiceEnabled) {
      openVoiceSettings();
      return;
    }
    api
      .voiceToggleRecording()
      .catch((err) => console.error("voice toggle failed:", err));
  }, [voiceEnabled, openVoiceSettings]);

  // Latest focused terminal for the voice paste target, readable from
  // listeners that are registered once.
  const voiceFocusRef = useRef<string | null>(null);
  // "Enviar para": an explicit voice target wins; then the project's
  // orchestrator, when one runs and the preference is on; then the focus.
  const [voiceTargetId, setVoiceTargetId] = useState<string | null>(null);
  const voiceToOrchestrator = usePreferencesStore((state) => state.voiceToOrchestrator);
  const exitedTerminals = useTerminalRuntimeStore((state) => state.exited);
  const orchestratorId = voiceToOrchestrator ? orchestratorOf(activeWorkspace, exitedTerminals) : null;
  const defaultTargetId = voiceTargetId ?? orchestratorId ?? focusedId;
  voiceFocusRef.current = defaultTargetId;

  // Writes dictated text to a terminal. An exited target is first resumed
  // with its agent's continuation command, then receives the prompt.
  const deliverDictation = async (id: string, text: string): Promise<void> => {
    const meta = workspaces.flatMap((workspace) => workspace.terminals).find((candidate) => candidate.id === id);
    if (meta && id in useTerminalRuntimeStore.getState().exited) {
      setVoiceFeedback(t("app.voice.resuming"));
      await sessions.restart(id, resolveResumeCommand(profileForCommand(meta.command), meta.command));
      // Give the agent's CLI a moment to draw its prompt before pasting.
      await new Promise((resolve) => setTimeout(resolve, RESUMED_AGENT_PROMPT_DELAY_MS));
    }
    // Outside the Workbench (Fleet, Settings) the xterm is not mounted; the
    // PTY still is, so write straight to it. Agent CLIs take bracketed paste.
    const term = getTerminal(id);
    if (!term && !meta) {
      setVoiceFeedback(t("app.voice.targetUnavailable"));
      return;
    }
    const profile = meta ? profileForCommand(meta.command) : null;
    const prompt = voiceCommandsEnabledRef.current && profile
      ? buildVoicePrompt(profile, text)
      : text;
    const bracketed = term ? term.modes.bracketedPasteMode : profile?.id !== "shell";
    try {
      await api.writeTerminal(id, promptPayload(prompt, bracketed));
      term?.focus();
      setVoiceSubmitted(true);
      setVoiceFeedback(t("app.voice.sent"));
    } catch (error) {
      console.error("voice dictation write failed:", error);
      dispatchVoiceCapsule({ type: "fail", message: t("app.voice.sendFailed") });
      setVoiceFeedback(t("app.voice.sendFailed"));
    }
  };
  const deliverDictationRef = useRef(deliverDictation);
  deliverDictationRef.current = deliverDictation;

  // A chosen target lasts for one capture; the next one starts at the focus.
  useEffect(() => {
    if (voiceCapsule.state === "idle") setVoiceTargetId(null);
  }, [voiceCapsule.state]);
  const voiceCommandsEnabledRef = useRef(voiceCommandsEnabled);
  voiceCommandsEnabledRef.current = voiceCommandsEnabled;

  const isVoiceModelError = (message: unknown): boolean => {
    const text = String(message ?? "").toLocaleLowerCase("pt-BR");
    return text.includes("model") || text.includes("modelo") || text.includes("whisper");
  };

  // Voice backend events. Parsed intents stop at the capsule preview; they
  // are executed only by the explicit Send/Confirm action below. Everything
  // else becomes a profile-aware prompt; transcript text is never interpreted
  // as a shell command.
  useEffect(() => {
    const unRecStart = listen("voice-recording-started", () => {
      setVoiceStatus("recording");
      setVoiceFeedback(null);
      setVoiceSubmitted(false);
      setVoiceLevel(0);
      setVoiceSamples([]);
      dispatchVoiceCapsule({ type: "start-listening" });
    });
    const unRecStop = listen("voice-recording-stopped", () => {
      setVoiceStatus("transcribing");
      dispatchVoiceCapsule({ type: "stop-listening" });
    });
    const unAudioLevel = listen<number>("voice-audio-level", (e) => {
      const level = Math.max(0, Math.min(1, Number(e.payload) || 0));
      setVoiceLevel(level);
      setVoiceSamples((previous) => [...previous.slice(-(VOICE_WAVEFORM_SAMPLES - 1)), level]);
    });
    const unTrStart = listen("voice-transcription-started", () => {
      setVoiceStatus("transcribing");
      dispatchVoiceCapsule({ type: "begin-transcription" });
    });
    const unTrDone = listen<string>("voice-transcription-complete", (e) => {
      setVoiceStatus("idle");
      const text = e.payload.trim();
      if (!text) {
        dispatchVoiceCapsule({ type: "transcription-ready", transcript: "", intent: null });
        setVoiceFeedback(t("app.voice.noTranscript"));
        return;
      }
      if (voiceCommandsEnabledRef.current) {
        const intent = parseVoiceCommand(text);
        if (intent) {
          dispatchVoiceCapsule({ type: "transcription-ready", transcript: text, intent });
          setVoiceSubmitted(false);
          setVoiceFeedback(isDestructiveVoiceIntent(intent)
            ? t("app.voice.reviewDestructive")
            : t("app.voice.reviewIntent"));
          return;
        }
      }

      // Ordinary dictation keeps the useful legacy behavior: it is pasted
      // into the focused terminal as text and never evaluated by the voice
      // layer. The transcript remains visible after the send.
      dispatchVoiceCapsule({ type: "transcription-ready", transcript: text, intent: null });
      setVoiceSubmitted(false);
      const id = voiceFocusRef.current;
      if (!id) {
        setVoiceFeedback(t("app.voice.readyPickTarget"));
        return;
      }
      void deliverDictationRef.current(id, text);
    });
    const unTrErr = listen<string>("voice-transcription-error", (e) => {
      setVoiceStatus("idle");
      dispatchVoiceCapsule({ type: "fail", message: e.payload || t("app.voice.transcriptionFailed") });
      setVoiceFeedback(e.payload || t("app.voice.transcriptionFailed"));
      console.error("voice transcription error:", e.payload);
      if (isVoiceModelError(e.payload)) {
        openVoiceSettings();
      }
    });
    const unRecErr = listen<string>("voice-recording-error", (e) => {
      setVoiceStatus("idle");
      dispatchVoiceCapsule({ type: "fail", message: e.payload || t("app.voice.captureFailed") });
      setVoiceFeedback(e.payload || t("app.voice.captureFailed"));
      console.error("voice recording error:", e.payload);
      if (isVoiceModelError(e.payload)) {
        openVoiceSettings();
      }
    });
    return () => {
      unRecStart.then((u) => u());
      unRecStop.then((u) => u());
      unAudioLevel.then((u) => u());
      unTrStart.then((u) => u());
      unTrDone.then((u) => u());
      unTrErr.then((u) => u());
      unRecErr.then((u) => u());
    };
  }, [workspaces]);


  const startVoiceCapture = () => {
    if (!voiceEnabled) {
      toggleVoice();
      return;
    }
    api.voiceToggleRecording().catch((error) => {
      console.error("voice start failed:", error);
      setVoiceFeedback(t("app.voice.startFailed"));
    });
  };

  const stopVoiceCapture = () => {
    if (voiceStatus !== "recording") return;
    api.voiceToggleRecording().catch((error) => {
      console.error("voice stop failed:", error);
      setVoiceFeedback(t("app.voice.stopFailed"));
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
    if (!voiceEnabled) {
      toggleVoice();
      return;
    }
    dispatchVoiceCapsule({ type: "retry" });
    setVoiceSubmitted(false);
    setVoiceFeedback(null);
    api.voiceToggleRecording().catch((error) => {
      console.error("voice retry failed:", error);
      dispatchVoiceCapsule({ type: "fail", message: t("app.voice.retryFailed") });
      setVoiceFeedback(t("app.voice.retryFailed"));
    });
  };

  const sendVoicePayload = async (payload: VoiceSendPayload, confirmed: boolean) => {
    if (payload.intent) {
      const success = await executeVoiceIntent(payload.intent, confirmed);
      if (success) setVoiceSubmitted(true);
      return;
    }

    // A transcript without a parsed intent is ordinary dictation. It can be
    // retried from the capsule if no terminal was focused when transcription
    // completed, but is always sent as text (never interpreted here).
    const id = voiceFocusRef.current;
    if (!id) {
      setVoiceFeedback(t("app.voice.pickTarget"));
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
    submitted: voiceSubmitted,
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
