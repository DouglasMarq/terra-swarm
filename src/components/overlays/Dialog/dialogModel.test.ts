import { describe, expect, it } from "vitest";

import { translateNow } from "../../../i18n";
import { getConfirmationCopy, requiresConfirmation } from "./dialogModel";

describe("dialog action policy", () => {
  it("requires an explicit confirmation for destructive actions", () => {
    expect(requiresConfirmation("destructive")).toBe(true);
    expect(getConfirmationCopy("destructive", translateNow).confirmLabel).toContain("exclusão");
  });

  it("keeps non-destructive actions confirmable without destructive language", () => {
    expect(requiresConfirmation("default")).toBe(false);
    expect(getConfirmationCopy("default", translateNow).confirmLabel).toBe("Confirmar");
  });
});

