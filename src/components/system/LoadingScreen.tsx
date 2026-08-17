import { CheckCircle2, LoaderCircle, Orbit } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";

import styles from "./system.module.css";

export type LoadingScreenPhase = "booting" | "hydrating" | "connecting" | "ready";

export interface LoadingScreenProps {
  /** Short label announced while the application is booting. */
  status?: ReactNode;
  /** Optional deterministic progress from 0 through 100. */
  progress?: number;
  title?: ReactNode;
  subtitle?: ReactNode;
  phase?: LoadingScreenPhase;
  className?: string;
}

const PHASE_LABELS: Record<LoadingScreenPhase, string> = {
  booting: "preparando o núcleo",
  hydrating: "restaurando o workspace",
  connecting: "conectando aos agentes",
  ready: "workspace pronto",
};

function clampProgress(progress: number) {
  return Math.min(100, Math.max(0, progress));
}

/**
 * Minimal boot surface for the Terra shell. The terrain is deliberately CSS
 * only so startup never waits on an image asset or a network request.
 */
export function LoadingScreen({
  className,
  phase = "booting",
  progress,
  status,
  subtitle = "Orquestrando sessões, agentes e sinais em um único espaço de trabalho.",
  title = "Terra Swarm",
}: LoadingScreenProps) {
  const progressValue = progress === undefined ? undefined : clampProgress(progress);
  const rootClassName = [styles.loadingScreen, className].filter(Boolean).join(" ");
  const progressStyle = (
    progressValue === undefined ? undefined : { width: `${progressValue}%` }
  ) as CSSProperties | undefined;

  return (
    <main className={rootClassName} aria-busy={phase !== "ready"}>
      <section className={styles.loadingPanel} aria-label="Inicialização do Terra Swarm">
        <div className={styles.loadingMark} aria-hidden="true">
          <Orbit />
        </div>
        <div className={styles.loadingCopy}>
          <p className={styles.loadingKicker}>terra / swarm</p>
          <h1 className={styles.loadingTitle}>{title}</h1>
          <p className={styles.loadingSubtitle}>{subtitle}</p>
        </div>
        <div className={styles.loadingStatus} role="status" aria-live="polite">
          {phase === "ready" ? (
            <CheckCircle2 className={styles.loadingReadyIcon} size={13} aria-hidden="true" />
          ) : (
            <LoaderCircle className={styles.loadingSpinner} size={13} aria-hidden="true" />
          )}
          <span>{status ?? PHASE_LABELS[phase]}</span>
        </div>
        {progressValue === undefined ? null : (
          <div
            className={styles.loadingProgress}
            role="progressbar"
            aria-label="Progresso da inicialização"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progressValue}
          >
            <div className={styles.loadingProgressValue} style={progressStyle} />
          </div>
        )}
      </section>
    </main>
  );
}
