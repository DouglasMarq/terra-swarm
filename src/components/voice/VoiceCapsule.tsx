import { useT } from "../../i18n";
import { AlertCircle, Check, ChevronUp, CircleStop, LoaderCircle, Mic, X } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";

import type { VoiceIntent } from "../../lib/voiceCommands";
import { Button } from "../ui/Button";
import { VoiceButton } from "./VoiceButton";
import {
  isDestructiveVoiceIntent,
  voiceIntentLabel,
  voiceStateLabel,
  type VoiceCapsuleIntent,
  type VoiceCapsuleState,
} from "./voiceModel";
import styles from "./voice.module.css";

export interface VoiceSendPayload {
  transcript: string;
  intent: VoiceCapsuleIntent | null;
  agent: string | null;
}

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
  submitted?: boolean;
  expanded?: boolean;
  disabled?: boolean;
  shortcut?: string;
  pushToTalk?: boolean;
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

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : 0));
}

function Waveform({ level = 0, samples = FALLBACK_SAMPLES }: Pick<VoiceCapsuleProps, "level" | "samples">) {
  const t = useT();
  const amplitude = clamp(level);
  const values = samples.length > 0 ? samples : FALLBACK_SAMPLES;

  return (
    <svg
      className={styles.waveform}
      viewBox="0 0 220 44"
      role="img"
      aria-label={t("settingsPanels.micLevel")}
      preserveAspectRatio="none"
    >
      {values.map((sample, index) => {
        const value = clamp(sample) * (0.28 + amplitude * 0.72);
        const height = 4 + value * 32;
        const x = (index / values.length) * 220 + 1;
        const width = Math.max(2, 220 / values.length - 3);
        return (
          <rect
            className={styles.waveformBar}
            key={`${index}-${sample}`}
            x={x}
            y={(44 - height) / 2}
            width={width}
            height={height}
            rx="2"
            style={{ "--bar-delay": `${index * 18}ms` } as CSSProperties}
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
  disabled = false,
  error,
  expanded = false,
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
  pushToTalk = false,
  samples,
  shortcut,
  state,
  submitted = false,
  targetAgent,
  transcript,
  finalTranscript,
}: VoiceCapsuleProps) {
  const t = useT();
  const safeIntent = intentPayload(intent);
  const currentTranscript = resolvedTranscript({ transcript, finalTranscript, partialTranscript });
  const destructive = isDestructiveVoiceIntent(safeIntent);
  const payload: VoiceSendPayload = {
    transcript: currentTranscript,
    intent: safeIntent,
    agent: targetAgent ?? null,
  };
  const statusText = error || voiceStateLabel(state, t);
  const isCapturing = state === "listening";
  const isBusy = state === "transcribing";
  const canSubmit = currentTranscript.length > 0 && !disabled && !isBusy;
  const classes = [styles.voiceCapsule, expanded && styles.expanded, className].filter(Boolean).join(" ");
  const titleId = "terra-voice-title";
  const statusId = "terra-voice-status";
  const transcriptId = "terra-voice-transcript";

  return (
    <section
      className={classes}
      data-state={state}
      data-expanded={expanded || undefined}
      data-destructive={destructive || undefined}
      aria-labelledby={titleId}
      aria-describedby={expanded ? `${statusId} ${transcriptId}` : statusId}
      role={expanded ? "dialog" : undefined}
      aria-modal={expanded ? "false" : undefined}
    >
      <header className={styles.header}>
        <div className={styles.headingGroup}>
          <span className={styles.eyebrow} id={titleId}>
            <Mic aria-hidden="true" size={13} /> {t("voiceCapsule.title")}
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
            aria-label={expanded ? t("voiceCapsule.collapse") : t("voiceCapsule.expand")}
            aria-expanded={expanded}
            onClick={onToggleExpanded}
          >
            <ChevronUp aria-hidden="true" size={15} />
          </button>
        ) : null}
      </header>

      <div className={styles.captureRow}>
        <VoiceButton
          className={styles.captureButton}
          disabled={disabled || isBusy}
          listening={isCapturing}
          onStart={onStartListening}
          onStop={onStopListening}
          pushToTalk={pushToTalk}
          shortcut={shortcut}
        />
        <div className={styles.waveformFrame} data-active={isCapturing || isBusy || undefined}>
          <Waveform level={level} samples={samples} />
          <span className={styles.captureHint}>
            {isCapturing ? t("voiceCapsule.speak") : pushToTalk ? t("voiceCapsule.holdToTalk") : t("voiceCapsule.tapToTalk")}
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
            {state === "error" ? t("voiceCapsule.noTranscript") : t("voiceCapsule.placeholder")}
          </p>
        )}
      </div>

      {targetAgent ? (
        <div className={styles.agentRow}>
          <span className={styles.agentKey}>{agentLabel ?? t("voiceCapsule.target")}</span>
          <span className={styles.agentValue}>{targetAgent}</span>
        </div>
      ) : null}

      {state === "preview" && safeIntent ? (
        <div className={styles.intentPreview} data-destructive={destructive || undefined}>
          <span className={styles.intentIcon} aria-hidden="true">
            {destructive ? <CircleStop size={14} /> : <Check size={14} />}
          </span>
          <div className={styles.intentCopy}>
            <span className={styles.intentLabel}>{t("voiceCapsule.recognized")}</span>
            <strong>{voiceIntentLabel(safeIntent, t)}</strong>
            {destructive ? <small>{t("voiceCapsule.needsConfirm")}</small> : null}
          </div>
        </div>
      ) : null}

      {state === "error" && onRetry ? (
        <button className={styles.retryButton} type="button" onClick={onRetry} disabled={disabled}>
          {t("nav.retry")}
        </button>
      ) : null}

      <footer className={styles.footer}>
        <span className={styles.shortcutHint}>
          {shortcut ? <>{t("voiceCapsule.shortcut")} <kbd>{shortcut}</kbd></> : pushToTalk ? t("voiceCapsule.pushToTalkOn") : ""}
        </span>
        <div className={styles.actions}>
          {(state !== "idle" || currentTranscript) && onCancel ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={onCancel}
              disabled={disabled}
              leadingIcon={<X aria-hidden="true" size={14} />}
            >
              {t("common.cancel")}
            </Button>
          ) : null}
          {state === "preview" && currentTranscript && !submitted ? (
            <Button
              type="button"
              size="sm"
              variant={destructive ? "danger" : "primary"}
              disabled={!canSubmit}
              onClick={() => (destructive ? onConfirm?.(payload) : onSend?.(payload))}
              leadingIcon={destructive ? <AlertCircle aria-hidden="true" size={14} /> : <Check aria-hidden="true" size={14} />}
            >
              {destructive ? t("voiceCapsule.confirmRun") : t("voiceCapsule.send")}
            </Button>
          ) : null}
          {isBusy ? (
            <span className={styles.busyLabel}>
              <LoaderCircle aria-hidden="true" size={14} /> {t("voiceCapsule.processing")}
            </span>
          ) : null}
        </div>
      </footer>
      {footer ? <div className={styles.customFooter}>{footer}</div> : null}
    </section>
  );
}
