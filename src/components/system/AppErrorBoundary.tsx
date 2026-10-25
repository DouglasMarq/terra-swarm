import { translateNow } from "../../i18n";
import { AlertTriangle, Check, ClipboardCopy, RefreshCw } from "lucide-react";
import {
  Component,
  type ErrorInfo,
  type ReactNode,
  type ErrorInfo as ReactErrorInfo,
} from "react";

import { getSafeErrorDetails, haveResetKeysChanged, type SafeErrorDetails } from "./errorModel";
import styles from "./system.module.css";

export interface AppErrorFallbackProps {
  error: unknown;
  details: SafeErrorDetails;
  isCopied: boolean;
  reset: () => void;
  copyDetails: () => Promise<void>;
}

export interface AppErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode | ((props: AppErrorFallbackProps) => ReactNode);
  resetKeys?: readonly unknown[];
  onError?: (error: unknown, info: ErrorInfo) => void;
  onReset?: () => void;
}

interface AppErrorBoundaryState {
  error: unknown | null;
  info: ErrorInfo | null;
  isCopied: boolean;
}

const INITIAL_STATE: AppErrorBoundaryState = { isCopied: false, error: null, info: null };

const COPIED_FEEDBACK_MS = 2_400;

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  private copyTimer: ReturnType<typeof setTimeout> | undefined;
  private previousResetKeys: readonly unknown[] | undefined;

  public constructor(props: AppErrorBoundaryProps) {
    super(props);
    this.state = INITIAL_STATE;
    this.previousResetKeys = props.resetKeys;
  }

  public static getDerivedStateFromError(error: unknown): Partial<AppErrorBoundaryState> {
    return { isCopied: false, error };
  }

  public componentDidCatch(error: unknown, info: ReactErrorInfo) {
    this.setState({ info });
    this.props.onError?.(error, info);
  }

  public componentDidUpdate() {
    const nextResetKeys = this.props.resetKeys;
    if (
      this.state.error !== null &&
      haveResetKeysChanged(this.previousResetKeys, nextResetKeys)
    ) {
      this.previousResetKeys = nextResetKeys;
      this.reset();
      return;
    }
    this.previousResetKeys = nextResetKeys;
  }

  public componentWillUnmount() {
    if (this.copyTimer !== undefined) clearTimeout(this.copyTimer);
  }

  private reset = () => {
    this.setState(INITIAL_STATE);
    this.props.onReset?.();
  };

  private copyDetails = async () => {
    const details = getSafeErrorDetails(this.state.error, this.state.info, translateNow);
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard-unavailable");
      await navigator.clipboard.writeText(details.text);
      this.setState({ isCopied: true });
      if (this.copyTimer !== undefined) clearTimeout(this.copyTimer);
      this.copyTimer = setTimeout(() => this.setState({ isCopied: false }), COPIED_FEEDBACK_MS);
    } catch {
      this.setState({ isCopied: false });
    }
  };

  public render() {
    if (this.state.error === null) return this.props.children;

    const details = getSafeErrorDetails(this.state.error, this.state.info, translateNow);
    const fallback = this.props.fallback;
    if (typeof fallback === "function") {
      return fallback({
        isCopied: this.state.isCopied,
        copyDetails: this.copyDetails,
        details,
        error: this.state.error,
        reset: this.reset,
      });
    }
    if (fallback !== undefined) return fallback;

    return (
      <main className={styles.errorBoundary} role="alert">
        <section className={styles.errorCard} aria-labelledby="terra-error-title">
          <div className={styles.errorHeading}>
            <span className={styles.errorIcon} aria-hidden="true">
              <AlertTriangle size={18} />
            </span>
            <div>
              <h1 id="terra-error-title" className={styles.errorTitle}>
                {translateNow("system.errorTitle")}
              </h1>
              <p className={styles.errorDescription}>
                {translateNow("system.errorBody")}
              </p>
            </div>
          </div>
          <pre className={styles.errorDetails}>{details.text}</pre>
          <div className={styles.errorActions}>
            <button
              type="button"
              className={`${styles.errorButton} ${styles.errorButtonPrimary}`}
              onClick={this.reset}
            >
              <RefreshCw size={14} aria-hidden="true" />
              {translateNow("nav.retry")}
            </button>
            <button type="button" className={styles.errorButton} onClick={this.copyDetails}>
              {this.state.isCopied ? (
                <Check size={14} aria-hidden="true" />
              ) : (
                <ClipboardCopy size={14} aria-hidden="true" />
              )}
              {this.state.isCopied ? translateNow("system.copied") : translateNow("system.copyReport")}
            </button>
          </div>
        </section>
      </main>
    );
  }
}
