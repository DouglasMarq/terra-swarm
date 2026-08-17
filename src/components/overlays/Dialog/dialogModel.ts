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
    return { title: "Confirmar ação", confirmLabel: "Confirmar exclusão" };
  }

  return { title: "Confirmar ação", confirmLabel: "Confirmar" };
}

