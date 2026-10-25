// @vitest-environment jsdom

import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useLocaleStore } from "../../i18n";
import { LoadingScreen } from "./LoadingScreen";

describe("system surfaces", () => {
  it("Given the app is loading, when the loading screen renders, then the loading state is announced accessibly", () => {
    render(<LoadingScreen phase="hydrating" progress={42} />);

    expect(screen.getByRole("progressbar", { name: "Progresso da inicialização" })).toHaveAttribute("aria-valuenow", "42");
    expect(screen.getByRole("status")).toHaveTextContent("restaurando o workspace");
  });

  it("Given the language changes, when the loading screen renders, then its copy follows the new language", () => {
    render(<LoadingScreen phase="hydrating" />);
    act(() => useLocaleStore.setState({ locale: "en" }));

    expect(screen.getByRole("status")).toHaveTextContent("restoring the workspace");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Terra Swarm");
  });
});
