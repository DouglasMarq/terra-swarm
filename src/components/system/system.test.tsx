// @vitest-environment jsdom

import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useLocaleStore } from "../../i18n";
import { LoadingScreen } from "./LoadingScreen";

describe("system surfaces", () => {
  it("announces the loading state accessibly", () => {
    render(<LoadingScreen phase="hydrating" progress={42} />);

    expect(screen.getByRole("progressbar", { name: "Progresso da inicialização" })).toHaveAttribute("aria-valuenow", "42");
    expect(screen.getByRole("status")).toHaveTextContent("restaurando o workspace");
  });

  it("given the language changes, re-renders the loading copy in the new language", () => {
    render(<LoadingScreen phase="hydrating" />);
    act(() => useLocaleStore.setState({ locale: "en" }));

    expect(screen.getByRole("status")).toHaveTextContent("restoring the workspace");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Terra Swarm");
  });
});
