import { t } from "../../i18n";
import type { ErrorInfo } from "react";

const MAX_NAME_LENGTH = 100;
const MAX_MESSAGE_LENGTH = 600;
const MAX_STACK_LENGTH = 2_000;

export interface SafeErrorDetails {
  name: string;
  message: string;
  componentStack: string;
  text: string;
}

function sanitizeText(value: string, maxLength: number) {
  return value
    .replace(/(?:[A-Za-z]:\\|\\\\)[^\s)]+/g, "[path]")
    .replace(/\/(?:home|Users|private|tmp)\/[^\s)]+/g, "[path]")
    .replace(/\b(?:sk|pk|ghp|xox)[_-][A-Za-z0-9_-]{12,}\b/gi, "[redacted-token]")
    .slice(0, maxLength)
    .trim();
}

function errorName(error: unknown) {
  if (error instanceof Error && error.name.trim()) {
    return sanitizeText(error.name, MAX_NAME_LENGTH);
  }
  return "UnknownError";
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message.trim()) {
    return sanitizeText(error.message, MAX_MESSAGE_LENGTH);
  }
  if (typeof error === "string" && error.trim()) {
    return sanitizeText(error, MAX_MESSAGE_LENGTH);
  }
  return "O aplicativo encontrou um erro inesperado.";
}

/** Convert React's error payload into a bounded, path/token-redacted report. */
export function getSafeErrorDetails(error: unknown, info?: ErrorInfo | null): SafeErrorDetails {
  const name = errorName(error);
  const message = errorMessage(error);
  const componentStack = sanitizeText(info?.componentStack?.trim() ?? "", MAX_STACK_LENGTH);
  const text = [
    t("system.reportTitle"),
    `${t("system.reportType")}: ${name}`,
    `${t("system.reportMessage")}: ${message}`,
    componentStack ? `${t("system.reportTree")}:\n${componentStack}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return { componentStack, message, name, text };
}

export function haveResetKeysChanged(
  previous: readonly unknown[] | undefined,
  next: readonly unknown[] | undefined,
) {
  if (previous === next) return false;
  if (!previous || !next || previous.length !== next.length) return true;
  return previous.some((value, index) => !Object.is(value, next[index]));
}
