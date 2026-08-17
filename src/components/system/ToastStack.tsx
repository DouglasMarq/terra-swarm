import { AlertCircle, CheckCircle2, Info, TriangleAlert, X } from "lucide-react";
import { createPortal } from "react-dom";
import { useEffect, useRef, type CSSProperties } from "react";

import {
  getToastDismissDelay,
  getToastRole,
  getToastTone,
  type ToastItem,
  type ToastTone,
} from "./toastModel";
import styles from "./system.module.css";

export type ToastPosition = "top-right" | "top-left" | "bottom-right" | "bottom-left";

export interface ToastStackProps {
  toasts: readonly ToastItem[];
  onDismiss: (id: string) => void;
  autoDismiss?: boolean;
  position?: ToastPosition;
  className?: string;
}

const TOAST_ICONS: Record<ToastTone, typeof Info> = {
  error: AlertCircle,
  info: Info,
  success: CheckCircle2,
  warning: TriangleAlert,
};

function ToastCard({
  autoDismiss,
  onDismiss,
  toast,
}: {
  autoDismiss: boolean;
  onDismiss: (id: string) => void;
  toast: ToastItem;
}) {
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;
  const tone = getToastTone(toast);
  const dismissDelay = getToastDismissDelay(toast, autoDismiss);
  const Icon = TOAST_ICONS[tone];

  useEffect(() => {
    if (dismissDelay === null) return undefined;
    const timer = window.setTimeout(() => onDismissRef.current(toast.id), dismissDelay);
    return () => window.clearTimeout(timer);
  }, [dismissDelay, toast.id]);

  const handleAction = () => {
    toast.action?.onClick?.();
    if (toast.action?.dismissOnClick) onDismiss(toast.id);
  };

  return (
    <article
      className={styles.toast}
      data-tone={tone}
      role={getToastRole(toast)}
      aria-atomic="true"
      style={
        {
          "--toast-duration": dismissDelay ? `${dismissDelay}ms` : undefined,
        } as CSSProperties
      }
    >
      <span className={styles.toastIcon} data-tone={tone} aria-hidden="true">
        <Icon size={14} strokeWidth={1.9} />
      </span>
      <div className={styles.toastCopy}>
        <p className={styles.toastTitle}>{toast.title}</p>
        {toast.description ? <p className={styles.toastDescription}>{toast.description}</p> : null}
        {toast.action ? (
          <button type="button" className={styles.toastAction} onClick={handleAction}>
            {toast.action.label}
          </button>
        ) : null}
      </div>
      {toast.dismissible === false ? null : (
        <button
          type="button"
          className={styles.toastClose}
          onClick={() => onDismiss(toast.id)}
          aria-label={`Dispensar: ${toast.title}`}
        >
          <X size={14} aria-hidden="true" />
        </button>
      )}
    </article>
  );
}

/**
 * Presentational, host-controlled notification stack. The caller owns the
 * toast list and receives every dismissal; auto-dismiss only schedules that
 * callback and never mutates local notification state.
 */
export function ToastStack({
  autoDismiss = true,
  className,
  onDismiss,
  position = "top-right",
  toasts,
}: ToastStackProps) {
  if (toasts.length === 0) return null;
  const rootClassName = [styles.toastViewport, className].filter(Boolean).join(" ");
  const content = (
    <div className={rootClassName} data-position={position} aria-label="Notificações">
      {toasts.map((toast) => (
        <ToastCard key={toast.id} autoDismiss={autoDismiss} onDismiss={onDismiss} toast={toast} />
      ))}
    </div>
  );

  return typeof document === "undefined" ? content : createPortal(content, document.body);
}
