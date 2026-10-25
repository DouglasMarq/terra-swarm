// @vitest-environment jsdom

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLocaleStore } from "../../i18n";
import { AppErrorBoundary } from "./AppErrorBoundary";

const failure = { isBroken: true };

function Fragile() {
  if (failure.isBroken) throw new Error("surface exploded");
  return <p>surface ok</p>;
}

beforeEach(() => {
  failure.isBroken = true;
  useLocaleStore.setState({ locale: "pt-BR" });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AppErrorBoundary", () => {
  it("Given a child that throws, when it renders, then the recovery surface is shown and the error is reported", () => {
    const onError = vi.fn();

    render(<AppErrorBoundary onError={onError}><Fragile /></AppErrorBoundary>);

    expect(screen.getByRole("alert")).toHaveTextContent("Esta superfície saiu do eixo");
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "surface exploded" }), expect.anything());
  });

  it("Given the recovery surface, when retry is pressed after the cause is fixed, then the child renders again", () => {
    const onReset = vi.fn();
    render(<AppErrorBoundary onReset={onReset}><Fragile /></AppErrorBoundary>);

    failure.isBroken = false;
    fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));

    expect(screen.getByText("surface ok")).toBeInTheDocument();
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it("Given the recovery surface, when the report is copied, then the clipboard receives it and the button confirms", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<AppErrorBoundary><Fragile /></AppErrorBoundary>);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copiar relatório" }));
    });

    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("surface exploded"));
    expect(screen.getByRole("button", { name: "Copiado" })).toBeInTheDocument();
  });

  it("Given no clipboard, when the report is copied, then the button stays as it was", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    render(<AppErrorBoundary><Fragile /></AppErrorBoundary>);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copiar relatório" }));
    });

    expect(screen.getByRole("button", { name: "Copiar relatório" })).toBeInTheDocument();
  });

  it("Given a fallback function, when a child throws, then it renders with the safe details", () => {
    render(
      <AppErrorBoundary fallback={({ details }) => <p>custom: {details.text.includes("surface exploded") ? "with message" : "without"}</p>}>
        <Fragile />
      </AppErrorBoundary>,
    );

    expect(screen.getByText("custom: with message")).toBeInTheDocument();
  });

  it("Given a recovered cause, when the reset keys change, then the child renders again without a click", () => {
    const { rerender } = render(<AppErrorBoundary fallback={<p>static fallback</p>} resetKeys={["first"]}><Fragile /></AppErrorBoundary>);
    expect(screen.getByText("static fallback")).toBeInTheDocument();

    failure.isBroken = false;
    rerender(<AppErrorBoundary fallback={<p>static fallback</p>} resetKeys={["second"]}><Fragile /></AppErrorBoundary>);

    expect(screen.getByText("surface ok")).toBeInTheDocument();
  });
});
