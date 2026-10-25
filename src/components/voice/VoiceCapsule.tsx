import { useT } from "../../i18n";
import { AlertCircle, Check, ChevronUp, CircleStop, LoaderCircle, Mic, X } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";

import type { VoiceIntent } from "../../domain/voiceCommands";
import { Button } from "../ui/Button";
import { clamp } from "../../lib/math/clamp";
import { VoiceButton } from "./VoiceButton";
import {
  isDestructiveVoiceIntent,
  voiceIntentLabel,
  voiceStateLabel,
  type VoiceCapsuleIntent,
  type VoiceCapsuleState,
  type VoiceSendPayload,
} from "./voiceModel";
import styles from "./voice.module.css";

export interface VoiceCapsuleProps {
  state: VoiceCapsuleState;
  /** Final text takes precedence; `transcript` is a convenient host alias. */
  transcript?: string;
  partialTranscript?: string;
  finalTranscript?: string;
  intent?: VoiceCapsuleIntent | VoiceIntent | null;
  targetAgent?: string | null;
  level?: number;
  samples?: readonly number[];
  error?: string | null;
  /** Keeps a successfully auto-sent dictation visible without allowing a duplicate send. */
  isSubmitted?: boolean;
  isExpanded?: boolean;
  isDisabled?: boolean;
  shortcut?: string;
  isPushToTalk?: boolean;
  className?: string;
  /** Optional label rendered beside the target-agent value. */
  agentLabel?: string;
  /** Additional content for a host-specific status row. */
  footer?: ReactNode;
  onStartListening?: () => void;
  onStopListening?: () => void;
  onCancel?: () => void;
  onRetry?: () => void;
  onSend?: (payload: VoiceSendPayload) => void;
  /** Called only after an explicit confirmation click for destructive intents. */
  onConfirm?: (payload: VoiceSendPayload) => void;
  onToggleExpanded?: () => void;
}

const FALLBACK_SAMPLES = [
  0.24, 0.38, 0.3, 0.54, 0.42, 0.78, 0.48, 0.33, 0.64, 0.88, 0.5, 0.32, 0.56, 0.76,
  0.44, 0.62, 0.36, 0.28, 0.52, 0.72, 0.4, 0.26,
];

const MIN_AMPLITUDE = 0;
const MAX_AMPLITUDE = 1;
const RESTING_BAR_SCALE = 0.28;
const LEVEL_BAR_SCALE = MAX_AMPLITUDE - RESTING_BAR_SCALE;
const WAVEFORM_WIDTH = 220;
const WAVEFORM_HEIGHT = 44;
const MIN_BAR_HEIGHT = 4;
const BAR_HEIGHT_RANGE = 32;
const BAR_OFFSET = 1;
const MIN_BAR_WIDTH = 2;
const BAR_GAP = 3;
const BAR_DELAY_STEP_MS = 18;

function clampAmplitude(value: number): number {
  return clamp(Number.isFinite(value) ? value : MIN_AMPLITUDE, MIN_AMPLITUDE, MAX_AMPLITUDE);
}

function Waveform({ level = 0, samples = FALLBACK_SAMPLES }: Pick<VoiceCapsuleProps, "level" | "samples">) {
  const translate = useT();
  const amplitude = clampAmplitude(level);
  const values = samples.length > 0 ? samples : FALLBACK_SAMPLES;

  return (
    <svg
      className={styles.waveform}
      viewBox={`0 0 ${WAVEFORM_WIDTH} ${WAVEFORM_HEIGHT}`}
      role="img"
      aria-label={translate("settingsPanels.micLevel")}
      preserveAspectRatio="none"
    >
      {values.map((sample, index) => {
        const value = clampAmplitude(sample) * (RESTING_BAR_SCALE + amplitude * LEVEL_BAR_SCALE);
        const height = MIN_BAR_HEIGHT + value * BAR_HEIGHT_RANGE;
        const barX = (index / values.length) * WAVEFORM_WIDTH + BAR_OFFSET;
        const width = Math.max(MIN_BAR_WIDTH, WAVEFORM_WIDTH / values.length - BAR_GAP);
        return (
          <rect
            className={styles.waveformBar}
            key={`${index}-${sample}`}
            x={barX}
            y={(WAVEFORM_HEIGHT - height) / 2}
            width={width}
            height={height}
            rx="2"
            style={{ "--bar-delay": `${index * BAR_DELAY_STEP_MS}ms` } as CSSProperties}
          />
        );
      })}
    </svg>
  );
}

function resolvedTranscript({ transcript, finalTranscript, partialTranscript }: Pick<
  VoiceCapsuleProps,
  "transcript" | "finalTranscript" | "partialTranscript"
>): string {
  return finalTranscript?.trim() || transcript?.trim() || partialTranscript?.trim() || "";
}

function intentPayload(intent: VoiceCapsuleProps["intent"]): VoiceCapsuleIntent | null {
  return intent ?? null;
}

export function VoiceCapsule({
  agentLabel,
  className,
  isDisabled = false,
  error,
  isExpanded = false,
  footer,
  intent,
  level,
  onCancel,
  onConfirm,
  onRetry,
  onSend,
  onStartListening,
  onStopListening,
  onToggleExpanded,
  partialTranscript,
  isPushToTalk = false,
  samples,
  shortcut,
  state,
  isSubmitted = false,
  targetAgent,
  transcript,
  finalTranscript,
}: VoiceCapsuleProps) {
  const translate = useT();
  const safeIntent = intentPayload(intent);
  const currentTranscript = resolvedTranscript({ transcript, finalTranscript, partialTranscript });
  const isDestructive = isDestructiveVoiceIntent(safeIntent);
  const payload: VoiceSendPayload = {
    transcript: currentTranscript,
    intent: safeIntent,
    agent: targetAgent ?? null,
  };
  const statusText = error || voiceStateLabel(state, translate);
  const isCapturing = state === "listening";
  const isBusy = state === "transcribing";
  const canSubmit = currentTranscript.length > 0 && !isDisabled && !isBusy;
  const classes = [styles.voiceCapsule, isExpanded && styles.expanded, className].filter(Boolean).join(" ");
  const titleId = "terra-voice-title";
  const statusId = "terra-voice-status";
  const transcriptId = "terra-voice-transcript";

  return (
    <section
      className={classes}
      data-state={state}
      data-expanded={isExpanded || undefined}
      data-destructive={isDestructive || undefined}
      aria-labelledby={titleId}
      aria-describedby={isExpanded ? `${statusId} ${transcriptId}` : statusId}
      role={isExpanded ? "dialog" : undefined}
      aria-modal={isExpanded ? "false" : undefined}
    >
      <header className={styles.header}>
        <div className={styles.headingGroup}>
          <span className={styles.eyebrow} id={titleId}>
            <Mic aria-hidden="true" size={13} /> {translate("voiceCapsule.title")}
          </span>
          <span
            className={styles.status}
            id={statusId}
            aria-live="polite"
            aria-atomic="true"
            data-state={state}
          >
            <span className={styles.statusMark} aria-hidden="true" />
            {statusText}
          </span>
        </div>
        {onToggleExpanded ? (
          <button
            className={styles.expandButton}
            type="button"
            aria-label={isExpanded ? translate("voiceCapsule.collapse") : translate("voiceCapsule.expand")}
            aria-expanded={isExpanded}
            onClick={onToggleExpanded}
          >
            <ChevronUp aria-hidden="true" size={15} />
          </button>
        ) : null}
      </header>

      <div className={styles.captureRow}>
        <VoiceButton
          className={styles.captureButton}
          disabled={isDisabled || isBusy}
          isListening={isCapturing}
          onStart={onStartListening}
          onStop={onStopListening}
          isPushToTalk={isPushToTalk}
          shortcut={shortcut}
        />
        <div className={styles.waveformFrame} data-active={isCapturing || isBusy || undefined}>
          <Waveform level={level} samples={samples} />
          <span className={styles.captureHint}>
            {isCapturing ? translate("voiceCapsule.speak") : isPushToTalk ? translate("voiceCapsule.holdToTalk") : translate("voiceCapsule.tapToTalk")}
          </span>
        </div>
      </div>

      <div className={styles.transcriptPanel} id={transcriptId} aria-live="polite">
        {currentTranscript ? (
          <p className={styles.transcript}>
            {currentTranscript}
            {state === "listening" && partialTranscript ? <span className={styles.cursor} aria-hidden="true" /> : null}
          </p>
        ) : (
          <p className={styles.placeholder}>
            {state === "error" ? translate("voiceCapsule.noTranscript") : translate("voiceCapsule.placeholder")}
          </p>
        )}
      </div>

      {targetAgent ? (
        <div className={styles.agentRow}>
          <span className={styles.agentKey}>{agentLabel ?? translate("voiceCapsule.target")}</span>
          <span className={styles.agentValue}>{targetAgent}</span>
        </div>
      ) : null}

      {state === "preview" && safeIntent ? (
        <div className={styles.intentPreview} data-destructive={isDestructive || undefined}>
          <span className={styles.intentIcon} aria-hidden="true">
            {isDestructive ? <CircleStop size={14} /> : <Check size={14} />}
          </span>
          <div className={styles.intentCopy}>
            <span className={styles.intentLabel}>{translate("voiceCapsule.recognized")}</span>
            <strong>{voiceIntentLabel(safeIntent, translate)}</strong>
            {isDestructive ? <small>{translate("voiceCapsule.needsConfirm")}</small> : null}
          </div>
        </div>
      ) : null}

      {state === "error" && onRetry ? (
        <button className={styles.retryButton} type="button" onClick={onRetry} disabled={isDisabled}>
          {translate("nav.retry")}
        </button>
      ) : null}

      <footer className={styles.footer}>
        <span className={styles.shortcutHint}>
          {shortcut ? <>{translate("voiceCapsule.shortcut")} <kbd>{shortcut}</kbd></> : isPushToTalk ? translate("voiceCapsule.pushToTalkOn") : ""}
        </span>
        <div className={styles.actions}>
          {(state !== "idle" || currentTranscript) && onCancel ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={onCancel}
              disabled={isDisabled}
              leadingIcon={<X aria-hidden="true" size={14} />}
            >
              {translate("common.cancel")}
            </Button>
          ) : null}
          {state === "preview" && currentTranscript && !isSubmitted ? (
            <Button
              type="button"
              size="sm"
              variant={isDestructive ? "danger" : "primary"}
              disabled={!canSubmit}
              onClick={() => (isDestructive ? onConfirm?.(payload) : onSend?.(payload))}
              leadingIcon={isDestructive ? <AlertCircle aria-hidden="true" size={14} /> : <Check aria-hidden="true" size={14} />}
            >
              {isDestructive ? translate("voiceCapsule.confirmRun") : translate("voiceCapsule.send")}
            </Button>
          ) : null}
          {isBusy ? (
            <span className={styles.busyLabel}>
              <LoaderCircle aria-hidden="true" size={14} /> {translate("voiceCapsule.processing")}
            </span>
          ) : null}
        </div>
      </footer>
      {footer ? <div className={styles.customFooter}>{footer}</div> : null}
    </section>
  );
}
