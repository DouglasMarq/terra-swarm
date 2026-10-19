import { t } from "../../../i18n";
export type ActionIntent = "default" | "destructive";

/** Destructive operations always need a separate, explicit confirmation step. */
export function requiresConfirmation(intent: ActionIntent): boolean {
  return intent === "destructive";
}

export function getConfirmationCopy(intent: ActionIntent): {
  title: string;
  confirmLabel: string;
} {
  if (requiresConfirmation(intent)) {
    return { title: t("dialogs.confirmTitle"), confirmLabel: t("dialogs.confirmDestructive") };
  }

  return { title: t("dialogs.confirmTitle"), confirmLabel: t("common.confirm") };
}

