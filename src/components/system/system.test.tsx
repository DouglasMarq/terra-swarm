// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LoadingScreen } from "./LoadingScreen";

describe("system surfaces", () => {
  it("announces the loading state accessibly", () => {
    render(<LoadingScreen phase="hydrating" progress={42} />);

    expect(screen.getByRole("progressbar", { name: "Progresso da inicialização" })).toHaveAttribute("aria-valuenow", "42");
    expect(screen.getByRole("status")).toHaveTextContent("restaurando o workspace");
  });
});
