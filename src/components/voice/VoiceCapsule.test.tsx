// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { VoiceCapsule } from "./VoiceCapsule";

describe("VoiceCapsule", () => {
  it("requires explicit confirmation for destructive voice intents", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onSend = vi.fn();
    render(
      <VoiceCapsule
        intent={{ type: "suspend-group", group: "Core" }}
        onConfirm={onConfirm}
        onSend={onSend}
        state="preview"
        targetAgent="Luna Max"
        transcript="Suspenda o grupo Core"
      />,
    );

    expect(screen.getByText("Confirmação explícita necessária para executar.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Confirmar e executar" }));
    expect(onConfirm).toHaveBeenCalledWith({
      transcript: "Suspenda o grupo Core",
      intent: { type: "suspend-group", group: "Core" },
      agent: "Luna Max",
    });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("exposes the listening control as a pressed state", async () => {
    const user = userEvent.setup();
    const onStartListening = vi.fn();
    render(<VoiceCapsule onStartListening={onStartListening} state="idle" />);
    const button = screen.getByRole("button", { name: "Iniciar captura de voz" });
    expect(button).toHaveAttribute("aria-pressed", "false");
    await user.click(button);
    expect(onStartListening).toHaveBeenCalledOnce();
  });
});
