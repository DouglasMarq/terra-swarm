export type ToastTone = "info" | "success" | "warning" | "error";

export interface ToastAction {
  label: string;
  onClick?: () => void;
  dismissOnClick?: boolean;
}

export interface ToastItem {
  id: string;
  title: string;
  description?: string;
  tone?: ToastTone;
  /** `0` or a negative value opts this toast out of auto-dismiss. */
  durationMs?: number;
  action?: ToastAction;
  dismissible?: boolean;
}

export const DEFAULT_TOAST_DURATION_MS = 5_000;

export function getToastTone(toast: Pick<ToastItem, "tone">) {
  return toast.tone ?? "info";
}

export function getToastDismissDelay(
  toast: Pick<ToastItem, "durationMs">,
  autoDismiss: boolean,
) {
  if (!autoDismiss) return null;
  const duration = toast.durationMs ?? DEFAULT_TOAST_DURATION_MS;
  return duration > 0 ? duration : null;
}

export function getToastRole(toast: Pick<ToastItem, "tone">) {
  return getToastTone(toast) === "error" ? "alert" : "status";
}

export function removeToast<T extends Pick<ToastItem, "id">>(
  toasts: readonly T[],
  id: string,
) {
  return toasts.filter((toast) => toast.id !== id);
}
