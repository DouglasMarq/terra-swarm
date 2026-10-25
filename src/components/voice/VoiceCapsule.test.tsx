// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { VoiceCapsule } from "./VoiceCapsule";

describe("VoiceCapsule", () => {
  it("Given a destructive voice intent, when sending it, then explicit confirmation is required", async () => {
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

  it("Given the capsule is listening, when it renders, then the listening control is exposed as pressed", async () => {
    const user = userEvent.setup();
    const onStartListening = vi.fn();
    render(<VoiceCapsule onStartListening={onStartListening} state="idle" />);
    const button = screen.getByRole("button", { name: "Iniciar captura de voz" });
    expect(button).toHaveAttribute("aria-pressed", "false");
    await user.click(button);
    expect(onStartListening).toHaveBeenCalledOnce();
  });
});
