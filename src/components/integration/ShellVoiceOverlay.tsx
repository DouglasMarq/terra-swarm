import { useT } from "../../i18n";
import type { AgentLabel } from "../../domain/agentLabels";
import { VoiceCapsule } from "../voice";
import { VoiceTargetPicker, type VoiceTargetProject } from "../voice/VoiceTargetPicker";
import type { VoiceCapsuleIntent, VoiceCapsuleState, VoiceSendPayload } from "../voice";
import type { CollapsedSidebarProject } from "../shell/Sidebar";

export interface ShellVoiceProps {
  isVoiceEnabled: boolean;
  voiceTranscript?: string;
  voicePartialTranscript?: string;
  voiceFinalTranscript?: string;
  voiceIntent?: VoiceCapsuleIntent | null;
  voiceTargetAgent?: string | null;
  /** Terminal that receives dictation (explicit choice or the focused one). */
  voiceTargetId?: string | null;
  onVoiceTargetChange?: (terminalId: string | null) => void;
  voiceLevel?: number;
  voiceSamples?: readonly number[];
  voiceError?: string | null;
  isVoiceSubmitted?: boolean;
  voiceFeedback?: string | null;
  onToggleVoice: () => void;
  onVoiceStartListening?: () => void;
  onVoiceStopListening?: () => void;
  onVoiceCancel?: () => void;
  onVoiceRetry?: () => void;
  onVoiceSend?: (payload: VoiceSendPayload) => void;
  onVoiceConfirm?: (payload: VoiceSendPayload) => void;
}

export interface VoiceTargetSource {
  projects: readonly CollapsedSidebarProject[];
  labels: Readonly<Record<string, AgentLabel | undefined>>;
}

interface ShellVoiceOverlayProps {
  voice: ShellVoiceProps;
  state: VoiceCapsuleState;
  focusedId: string | null;
  targets: VoiceTargetSource;
  shortcut: string;
}

function voiceTargetProjects({ projects, labels }: VoiceTargetSource): VoiceTargetProject[] {
  return projects.map((project) => ({
    id: project.id,
    name: project.name,
    agents: project.agents.map((agent) => ({
      id: agent.id,
      primary: labels[agent.id]?.primary ?? agent.label,
      tag: labels[agent.id]?.tag ?? agent.label,
      status: agent.status,
      detail: agent.detail,
    })),
  }));
}

export function ShellVoiceOverlay({ voice, state, focusedId, targets, shortcut }: ShellVoiceOverlayProps) {
  const translate = useT();
  if (state === "idle") return null;
  return (
    <div className="terra-voice-overlay">
      {voice.onVoiceTargetChange ? (
        <VoiceTargetPicker projects={voiceTargetProjects(targets)} targetId={voice.voiceTargetId ?? focusedId} onChange={voice.onVoiceTargetChange} />
      ) : null}
      <VoiceCapsule
        state={state}
        isDisabled={!voice.isVoiceEnabled}
        shortcut={shortcut}
        transcript={voice.voiceTranscript}
        partialTranscript={voice.voicePartialTranscript}
        finalTranscript={voice.voiceFinalTranscript}
        intent={voice.voiceIntent}
        targetAgent={voice.voiceTargetAgent}
        level={voice.voiceLevel}
        samples={voice.voiceSamples}
        error={voice.voiceError}
        isSubmitted={voice.isVoiceSubmitted}
        onStartListening={voice.onVoiceStartListening ?? voice.onToggleVoice}
        onStopListening={voice.onVoiceStopListening ?? voice.onToggleVoice}
        onCancel={voice.onVoiceCancel ?? voice.onToggleVoice}
        onRetry={voice.onVoiceRetry}
        onSend={voice.onVoiceSend}
        onConfirm={voice.onVoiceConfirm}
        footer={<span role="status">{voice.voiceFeedback || (voice.isVoiceEnabled ? translate("shell.voiceReady") : translate("shell.voiceDisabled"))}</span>}
      />
    </div>
  );
}
