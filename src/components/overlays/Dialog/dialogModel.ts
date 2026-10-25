import type { Translate } from "../../../i18n";
export type ActionIntent = "default" | "destructive";

/** Destructive operations always need a separate, explicit confirmation step. */
export function requiresConfirmation(intent: ActionIntent): boolean {
  return intent === "destructive";
}

export function getConfirmationCopy(intent: ActionIntent, translate: Translate): {
  title: string;
  confirmLabel: string;
} {
  if (requiresConfirmation(intent)) {
    return { title: translate("dialogs.confirmTitle"), confirmLabel: translate("dialogs.confirmDestructive") };
  }

  return { title: translate("dialogs.confirmTitle"), confirmLabel: translate("common.confirm") };
}

