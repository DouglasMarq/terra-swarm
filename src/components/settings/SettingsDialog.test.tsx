// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useLocaleStore } from "../../i18n";
import { SettingsDialog } from "./SettingsDialog";
import { SETTINGS_SECTIONS } from "./settingsModel";
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

describe("SettingsDialog in English", () => {
  beforeEach(() => {
    useLocaleStore.setState({ locale: "en" });
  });

  it("Given the search field, when using the arrow keys and Enter, then focus moves to the section tabs", async () => {
    const user = userEvent.setup();
    render(<SettingsDialog onOpenChange={vi.fn()} isOpen defaultSection="voice" />);
    const search = screen.getByRole("searchbox", { name: "Search settings" });

    await user.click(search);
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("tab", { name: "Voice" })).toHaveFocus();

    await user.click(search);
    await user.keyboard("{ArrowUp}");
    expect(screen.getByRole("tab", { name: "About" })).toHaveFocus();

    await user.click(search);
    await user.type(search, "term{Enter}");
    expect(screen.getByRole("tab", { name: "Terminal" })).toHaveFocus();
  });

  it("Given a search with no match, when pressing Escape, then the query clears and the sections come back", async () => {
    const user = userEvent.setup();
    render(<SettingsDialog onOpenChange={vi.fn()} isOpen />);
    const search = screen.getByRole("searchbox", { name: "Search settings" });

    await user.type(search, "zzzz");
    expect(screen.getByRole("status")).toHaveTextContent("No section found");
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    await user.keyboard("{ArrowDown}");
    expect(search).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(search).toHaveValue("");
    expect(search).toHaveFocus();
    expect(screen.getAllByRole("tab")).toHaveLength(SETTINGS_SECTIONS.length);
  });

  it("Given a section asking for confirmation, when confirming, then the action runs and the prompt closes", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <SettingsDialog
        onOpenChange={vi.fn()}
        isOpen
        slots={{
          general: ({ requestConfirmation }) => (
            <button
              type="button"
              onClick={() => requestConfirmation({ title: "Wipe data?", description: "This cannot be undone.", confirmLabel: "Wipe", onConfirm })}
            >
              Wipe everything
            </button>
          ),
        }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Wipe everything" }));
    const prompt = await screen.findByRole("dialog", { name: "Wipe data?" });
    expect(prompt).toHaveTextContent("This cannot be undone.");
    await user.click(screen.getByRole("button", { name: "Wipe" }));

    expect(onConfirm).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Wipe data?" })).not.toBeInTheDocument());
  });

  it("Given a confirmation prompt, when cancelling, then the action does not run", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <SettingsDialog
        onOpenChange={vi.fn()}
        isOpen
        slots={{
          general: ({ requestConfirmation }) => (
            <button type="button" onClick={() => requestConfirmation({ title: "Reset?", description: "Back to defaults.", onConfirm })}>
              Reset all
            </button>
          ),
        }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Reset all" }));
    await screen.findByRole("dialog", { name: "Reset?" });
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onConfirm).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Reset?" })).not.toBeInTheDocument());
  });

  it("Given header and footer slots, when the dialog renders, then they receive the context and can close it", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <SettingsDialog
        onOpenChange={onOpenChange}
        isOpen
        title="Preferences"
        description="Tune the app."
        defaultSection="data"
        headerSlot={<span>Header extra</span>}
        footerSlot={() => <span>Footer extra</span>}
      />,
    );

    expect(screen.getByRole("dialog", { name: "Preferences" })).toHaveTextContent("Tune the app.");
    expect(screen.getByText("Header extra")).toBeInTheDocument();
    expect(screen.getByText("Footer extra")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Configure data & backup" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Close settings" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("Given a search, when the dialog closes and opens again, then the search starts empty", async () => {
    const user = userEvent.setup();
    const view = render(<SettingsDialog onOpenChange={vi.fn()} isOpen />);

    await user.type(screen.getByRole("searchbox", { name: "Search settings" }), "voice");
    view.rerender(<SettingsDialog onOpenChange={vi.fn()} isOpen={false} />);
    view.rerender(<SettingsDialog onOpenChange={vi.fn()} isOpen />);

    expect(screen.getByRole("searchbox", { name: "Search settings" })).toHaveValue("");
  });

  it("Given a controlled section, when the user picks another tab, then only the host decides", async () => {
    const user = userEvent.setup();
    const onActiveSectionChange = vi.fn();
    render(<SettingsDialog onOpenChange={vi.fn()} isOpen activeSection="about" onActiveSectionChange={onActiveSectionChange} />);

    await user.click(screen.getByRole("tab", { name: "Voice" }));

    expect(onActiveSectionChange).toHaveBeenCalledWith("voice");
    expect(screen.getByRole("tab", { name: "About" })).toHaveAttribute("aria-selected", "true");
  });

  it("Given the selected section is removed, when the sections change, then the first remaining one is selected", () => {
    const view = render(<SettingsDialog onOpenChange={vi.fn()} isOpen defaultSection="voice" />);
    expect(screen.getByRole("tab", { name: "Voice" })).toHaveAttribute("aria-selected", "true");

    view.rerender(
      <SettingsDialog onOpenChange={vi.fn()} isOpen sections={SETTINGS_SECTIONS.filter((section) => section.id !== "voice")} />,
    );

    expect(screen.getByRole("tab", { name: "General" })).toHaveAttribute("aria-selected", "true");
  });

  it("Given the page variant, when pressing Ctrl+K, then it renders inline and leaves focus alone", () => {
    render(<SettingsDialog onOpenChange={vi.fn()} isOpen variant="page" />);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Settings" })).toBeInTheDocument();
    expect(screen.queryByText("Esc")).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(screen.getByRole("searchbox", { name: "Search settings" })).not.toHaveFocus();
  });
});
