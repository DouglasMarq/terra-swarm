// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SettingsDialog } from "./SettingsDialog";
import settingsStyles from "./SettingsDialog.module.css?raw";

describe("SettingsDialog", () => {
  it("Given the settings, when navigating sections, then the selected slot is rendered", async () => {
    const user = userEvent.setup();
    const onActiveSectionChange = vi.fn();
    render(
      <SettingsDialog
        onActiveSectionChange={onActiveSectionChange}
        onOpenChange={vi.fn()}
        isOpen
        slots={{
          voice: ({ section }) => <p>Voice settings for {section.label}</p>,
        }}
      />,
    );

    expect(screen.getByRole("dialog", { name: "Configurações" })).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Voz" }));
    expect(onActiveSectionChange).toHaveBeenCalledWith("voice");
    expect(screen.getByText("Voice settings for Voz")).toBeInTheDocument();
  });

  it("Given the settings search, when typing, then categories are filtered", async () => {
    const user = userEvent.setup();
    render(<SettingsDialog onOpenChange={vi.fn()} isOpen />);

    const search = screen.getByRole("searchbox", { name: "Buscar configurações" });
    await user.type(search, "voz");
    expect(screen.getByRole("tab", { name: "Voz" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Perfil" })).not.toBeInTheDocument();
    expect(screen.getByText("1 resultado")).toBeInTheDocument();
  });

  it("Given the settings, when pressing Ctrl+K, then it stays inside settings and focuses the search", () => {
    render(<SettingsDialog onOpenChange={vi.fn()} isOpen />);

    const search = screen.getByRole("searchbox", { name: "Buscar configurações" });
    screen.getByRole("tab", { name: "Voz" }).focus();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });

    expect(search).toHaveFocus();
  });

  it("Given settings content, when it renders, then it scrolls only when its content needs it", () => {
    expect(settingsStyles).toMatch(
      /\.sectionContent\s*\{[\s\S]*?min-height:\s*0;[\s\S]*?box-sizing:\s*border-box;/,
    );
    expect(settingsStyles).toMatch(/\.main\s*\{[\s\S]*?overflow-y:\s*auto;/);
  });
});
