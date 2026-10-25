import { describe, expect, it } from "vitest";

import { translateNow } from "../../../i18n";
import { getConfirmationCopy, requiresConfirmation } from "./dialogModel";

describe("dialog action policy", () => {
  it("Given a destructive action, when reading its policy, then an explicit confirmation is required", () => {
    expect(requiresConfirmation("destructive")).toBe(true);
    expect(getConfirmationCopy("destructive", translateNow).confirmLabel).toContain("exclusão");
  });

  it("Given a non-destructive action, when reading its policy, then it stays confirmable without destructive language", () => {
    expect(requiresConfirmation("default")).toBe(false);
    expect(getConfirmationCopy("default", translateNow).confirmLabel).toBe("Confirmar");
  });
});

