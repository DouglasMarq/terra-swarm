import { describe, expect, it } from "vitest";

import { getConfirmationCopy, requiresConfirmation } from "./dialogModel";

describe("dialog action policy", () => {
  it("requires an explicit confirmation for destructive actions", () => {
    expect(requiresConfirmation("destructive")).toBe(true);
    expect(getConfirmationCopy("destructive").confirmLabel).toContain("exclusão");
  });

  it("keeps non-destructive actions confirmable without destructive language", () => {
    expect(requiresConfirmation("default")).toBe(false);
    expect(getConfirmationCopy("default").confirmLabel).toBe("Confirmar");
  });
});

