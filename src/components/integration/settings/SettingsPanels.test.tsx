// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServerInfo } from "../../../domain/mcp.model";
import type { VoiceModelInfo } from "../../../domain/voice.model";

const ipc = vi.hoisted(() => ({
  listSystemFonts: vi.fn(),
  mcpServerInfo: vi.fn(),
  mcpSetEnabled: vi.fn(),
  audioLevel: null as ((level: number) => void) | null,
}));

vi.mock("../../../api", () => ({ api: { listSystemFonts: ipc.listSystemFonts } }));

vi.mock("../../../lib/tauri/mcp", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/tauri/mcp")>()),
  mcpApi: { mcpServerInfo: ipc.mcpServerInfo, mcpSetEnabled: ipc.mcpSetEnabled },
}));

vi.mock("../../../lib/tauri/voice", () => ({
  onVoiceAudioLevel: (handler: (level: number) => void) => {
    ipc.audioLevel = handler;
    return Promise.resolve(() => {
      ipc.audioLevel = null;
    });
  },
}));

import { useLocaleStore } from "../../../i18n";
import { DEFAULT_FEATURE_FLAGS } from "../../../lib/features/featureFlags";
import { useMcpStore } from "../../../stores/mcpStore";
import { DEFAULT_HOTKEYS, usePreferencesStore } from "../../../stores/preferencesStore";
import { SettingsDialog } from "../../settings/SettingsDialog";
import type { SettingsSectionId } from "../../settings";
import { SettingsSectionPanel, type SettingsPanelsProps } from "./SettingsPanels";

type PanelProps = Omit<SettingsPanelsProps, "section">;

const initialPreferences = usePreferencesStore.getState();

const runningServer: McpServerInfo = {
  isEnabled: true,
  isAvailable: true,
  isRunning: true,
  url: "http://127.0.0.1:7777/mcp",
  port: 7777,
  dbPath: "/tmp/terra/mcp.db",
  error: null,
};

function model(id: string, extra: Partial<VoiceModelInfo> = {}): VoiceModelInfo {
  return {
    id,
    displayName: `Whisper ${id}`,
    sizeLabel: "75 MB",
    description: `Model ${id}`,
    isDownloaded: false,
    isActive: false,
    ...extra,
  };
}

function panelProps(overrides: Partial<PanelProps> = {}): PanelProps {
  return {
    agents: [],
    defaultAgent: null,
    onDefaultAgentChange: vi.fn(),
    availableShells: ["/bin/zsh", "/bin/bash"],
    defaultShell: "",
    onDefaultShellChange: vi.fn(),
    fontSize: 13,
    onFontSizeChange: vi.fn(),
    onFontSizeReset: vi.fn(),
    gridCols: 2,
    onGridLayoutChange: vi.fn(),
    shouldReduceMotion: false,
    onReduceMotionChange: vi.fn(),
    flags: DEFAULT_FEATURE_FLAGS,
    onFeatureFlagChange: vi.fn(),
    isVoiceEnabled: false,
    onVoiceEnabledChange: vi.fn(),
    voiceLang: "auto",
    onVoiceLangChange: vi.fn(),
    voiceInputDevice: null,
    voiceInputDevices: [],
    onVoiceInputDeviceChange: vi.fn(),
    isMicAvailable: true,
    isMicTesting: false,
    onMicTestToggle: vi.fn(),
    voiceModels: [],
    voiceDownload: null,
    onVoiceModelSelect: vi.fn(),
    onVoiceModelDownload: vi.fn(),
    hotkeys: DEFAULT_HOTKEYS,
    capturing: null,
    onCaptureHotkey: vi.fn(),
    onResetHotkeys: vi.fn(),
    snapshotOperation: null,
    snapshotFeedback: null,
    onExportSnapshot: vi.fn(),
    onImportSnapshot: vi.fn(),
    appVersion: "1.4.0",
    updateVersion: null,
    isUpdateInstalling: false,
    updateCheckState: "idle",
    onManualUpdateCheck: vi.fn(),
    onInstallUpdate: vi.fn(),
    ...overrides,
  };
}

function renderSettings(sectionId: SettingsSectionId, overrides: Partial<PanelProps> = {}) {
  const props = panelProps(overrides);
  const view = render(
    <SettingsDialog
      isOpen
      onOpenChange={vi.fn()}
      defaultSection={sectionId}
      renderSection={({ section }) => <SettingsSectionPanel section={section} {...props} />}
    />,
  );
  return { props, view };
}

beforeEach(() => {
  useLocaleStore.setState({ locale: "en" });
  localStorage.clear();
  usePreferencesStore.setState(initialPreferences, true);
  useMcpStore.setState({ server: null, error: null });
  ipc.listSystemFonts.mockReset().mockResolvedValue([
    { name: "JetBrains Mono", isMonospace: true },
    { name: "Fira Code", isMonospace: true },
    { name: "Arial", isMonospace: false },
  ]);
  ipc.mcpServerInfo.mockReset().mockResolvedValue(runningServer);
  ipc.mcpSetEnabled.mockReset().mockResolvedValue({ ...runningServer, isEnabled: false });
  ipc.audioLevel = null;
});

describe("SettingsSectionPanel general", () => {
  it("Given the general section, when the user picks another language, then the interface switches to it", async () => {
    const user = userEvent.setup();
    renderSettings("general");

    await user.selectOptions(screen.getByRole("combobox", { name: "Interface language" }), "pt-BR");

    expect(useLocaleStore.getState().locale).toBe("pt-BR");
    expect(screen.getByRole("heading", { name: "Geral" })).toBeInTheDocument();
  });

  it("Given the general section, when toggling notifications, motion and labs, then each preference changes", async () => {
    const user = userEvent.setup();
    const { props } = renderSettings("general", { shouldReduceMotion: true });

    await user.click(screen.getByRole("switch", { name: "Notify me when an agent needs me" }));
    expect(usePreferencesStore.getState().isSystemNotificationsEnabled).toBe(false);

    const reduceMotion = screen.getByRole("switch", { name: "Reduce motion" });
    expect(reduceMotion).toHaveAttribute("aria-checked", "true");
    await user.click(reduceMotion);
    expect(props.onReduceMotionChange).toHaveBeenCalledWith(false);

    await user.click(screen.getByRole("switch", { name: "Voice commands" }));
    expect(props.onFeatureFlagChange).toHaveBeenCalledWith("voiceCommands", !DEFAULT_FEATURE_FLAGS.voiceCommands);
  });
});

describe("SettingsSectionPanel terminal", () => {
  it("Given installed fonts, when filtering and picking one, then the terminal font changes", async () => {
    const user = userEvent.setup();
    renderSettings("terminal");

    expect(screen.getByText("Reading installed fonts…")).toBeInTheDocument();
    expect(await screen.findByText("3 fonts installed · 2 monospace.")).toBeInTheDocument();
    const list = screen.getByRole("listbox", { name: "Font" });
    expect(within(list).getByRole("option", { name: /Default \(JetBrains Mono\)/ })).toHaveAttribute("aria-selected", "true");

    await user.click(screen.getByRole("button", { name: "Monospace only" }));
    expect(within(list).queryByRole("option", { name: /Arial/ })).not.toBeInTheDocument();

    await user.type(screen.getByRole("searchbox", { name: "Filter fonts" }), "fira");
    expect(within(list).queryByRole("option", { name: /Default/ })).not.toBeInTheDocument();
    await user.click(within(list).getByRole("option", { name: /Fira Code/ }));

    expect(usePreferencesStore.getState().terminalFontFamily).toBe("Fira Code");
    expect(within(list).getByRole("option", { name: /Fira Code/ })).toHaveAttribute("aria-selected", "true");
  });

  it("Given a saved font that is no longer installed, when the filter matches nothing, then it is flagged and an empty message shows", async () => {
    const user = userEvent.setup();
    usePreferencesStore.setState({ terminalFontFamily: "Gone Mono" });
    renderSettings("terminal");

    const list = screen.getByRole("listbox", { name: "Font" });
    expect(await within(list).findByRole("option", { name: /Gone Mono\s*not installed/ })).toBeInTheDocument();

    await user.type(screen.getByRole("searchbox", { name: "Filter fonts" }), "zzz");

    expect(screen.getByText("No font matches this filter.")).toBeInTheDocument();
  });

  it("Given the terminal section, when changing size, grid and shell, then the host is told", async () => {
    const user = userEvent.setup();
    const { props } = renderSettings("terminal", { fontSize: 8, defaultShell: "/opt/fish" });

    expect(screen.getByRole("button", { name: "Smaller font" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Larger font" }));
    expect(props.onFontSizeChange).toHaveBeenCalledWith(1);
    await user.click(screen.getByRole("button", { name: "Reset" }));
    expect(props.onFontSizeReset).toHaveBeenCalled();

    const columns = screen.getByLabelText("Grid columns");
    expect(within(columns).getByRole("button", { name: "2" })).toHaveAttribute("aria-pressed", "true");
    await user.click(within(columns).getByRole("button", { name: "3" }));
    expect(props.onGridLayoutChange).toHaveBeenCalledWith(3);

    const shell = screen.getByRole("combobox", { name: "Shell used by new sessions" });
    expect(within(shell).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "System default",
      "/opt/fish",
      "/bin/zsh",
      "/bin/bash",
    ]);
    await user.selectOptions(shell, "/bin/bash");
    expect(props.onDefaultShellChange).toHaveBeenCalledWith("/bin/bash");
  });

  it("Given the largest font size, when the terminal section renders, then the larger button is disabled", () => {
    renderSettings("terminal", { fontSize: 32 });

    expect(screen.getByRole("button", { name: "Larger font" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Smaller font" })).toBeEnabled();
  });
});

describe("SettingsSectionPanel voice", () => {
  it("Given no microphone and voice off, when the voice section renders, then turning voice on is blocked", () => {
    renderSettings("voice", { isMicAvailable: false });

    expect(screen.getByRole("switch", { name: "Turn on voice input" })).toBeDisabled();
    expect(screen.getByText("No microphone found. Connect one to turn voice on.")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Language" })).not.toBeInTheDocument();
  });

  it("Given voice on, when choosing language, device and testing the mic, then the host is told and the meter follows the level", async () => {
    const user = userEvent.setup();
    const { props, view } = renderSettings("voice", {
      isVoiceEnabled: true,
      voiceInputDevice: "USB Mic",
      voiceInputDevices: ["MacBook Mic"],
    });

    await user.click(screen.getByRole("switch", { name: "Turn on voice input" }));
    expect(props.onVoiceEnabledChange).toHaveBeenCalledWith(false);

    await user.selectOptions(screen.getByRole("combobox", { name: "Language" }), "en");
    expect(props.onVoiceLangChange).toHaveBeenCalledWith("en");

    const device = screen.getByRole("combobox", { name: "Input device" });
    expect(within(device).getByRole("option", { name: "USB Mic (disconnected)" })).toBeInTheDocument();
    await user.selectOptions(device, "MacBook Mic");
    expect(props.onVoiceInputDeviceChange).toHaveBeenCalledWith("MacBook Mic");

    await user.click(screen.getByRole("button", { name: "Test" }));
    expect(props.onMicTestToggle).toHaveBeenCalled();

    view.rerender(
      <SettingsDialog
        isOpen
        onOpenChange={vi.fn()}
        defaultSection="voice"
        renderSection={({ section }) => <SettingsSectionPanel section={section} {...props} isMicTesting />}
      />,
    );
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
    expect(screen.getByText("Speak into the microphone. The meter should follow your voice.")).toBeInTheDocument();
    await waitFor(() => expect(ipc.audioLevel).not.toBeNull());
    act(() => ipc.audioLevel?.(0.05));
    expect(screen.getByLabelText("Microphone level").firstElementChild).toHaveStyle({ transform: "scaleX(0.5)" });
    act(() => ipc.audioLevel?.(1));
    expect(screen.getByLabelText("Microphone level").firstElementChild).toHaveStyle({ transform: "scaleX(1)" });

    await user.click(screen.getByRole("switch", { name: "Talk to the orchestrator" }));
    expect(usePreferencesStore.getState().shouldSendVoiceToOrchestrator).toBe(false);

    view.unmount();
    await waitFor(() => expect(ipc.audioLevel).toBeNull());
  });

  it("Given the model list is loading, when the voice section renders, then a loading message shows", () => {
    renderSettings("voice", { voiceModelsStatus: "loading" });

    expect(screen.getByText("Loading models…")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("Given the model list failed, when retrying, then the host reloads it", async () => {
    const user = userEvent.setup();
    const onRetryVoiceModels = vi.fn();
    renderSettings("voice", { voiceModelsStatus: "error", onRetryVoiceModels });

    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't read the model list.");
    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(onRetryVoiceModels).toHaveBeenCalled();
  });

  it("Given the model list failed without a retry, when the voice section renders, then only the failure shows", () => {
    renderSettings("voice", { voiceModelsStatus: "error" });

    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't read the model list.");
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });

  it("Given no downloaded model, when downloading one, then the host starts the download", async () => {
    const user = userEvent.setup();
    const { props } = renderSettings("voice", { voiceModels: [model("tiny"), model("base")] });

    expect(screen.getByText("Download a model to start using voice input.")).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: "Download" })[0]);

    expect(props.onVoiceModelDownload).toHaveBeenCalledWith("tiny");
  });

  it("Given models in every state, when the voice section renders, then each shows its action", async () => {
    const user = userEvent.setup();
    const { props } = renderSettings("voice", {
      voiceModels: [
        model("tiny", { isDownloaded: true, isActive: true }),
        model("base", { isDownloaded: true }),
        model("small"),
        model("large"),
      ],
      voiceDownload: { id: "small", percent: 42.7 },
    });

    expect(screen.queryByText("Download a model to start using voice input.")).not.toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText("42%")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Use" }));

    expect(props.onVoiceModelSelect).toHaveBeenCalledWith("base");
  });
});

describe("SettingsSectionPanel agents", () => {
  const agents = [
    { id: "claude", label: "Claude Code", isAvailable: true },
    { id: "codex", label: "Codex", isAvailable: false },
    { id: "custom-cli", label: "Custom CLI", isAvailable: true },
    { id: "shell", label: "Shell", isAvailable: true },
  ];

  it("Given detected agents, when picking the default one, then only installed agents are offered", async () => {
    const user = userEvent.setup();
    const { props } = renderSettings("agents", { agents, defaultAgent: "claude" });

    const select = screen.getByRole("combobox", { name: "Profile used by quick add" });
    expect(within(select).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Ask every time",
      "Claude Code (claude)",
      "Custom CLI (custom-cli)",
      "Shell (shell)",
    ]);
    await user.selectOptions(select, "");
    expect(props.onDefaultAgentChange).toHaveBeenCalledWith(null);
    await user.selectOptions(select, "custom-cli");
    expect(props.onDefaultAgentChange).toHaveBeenCalledWith("custom-cli");

    expect(screen.getByText("not installed")).toBeInTheDocument();
    expect(screen.getAllByText("available")).toHaveLength(3);
    expect(screen.getAllByRole("button", { name: "Launch options" })).toHaveLength(2);
  });

  it("Given no detected agent, when the agents section renders, then an empty message shows", () => {
    renderSettings("agents");

    expect(screen.getByText("No agent detected yet.")).toBeInTheDocument();
  });

  it("Given launch options, when typing args and env and leaving the field, then they are saved and flagged", async () => {
    const user = userEvent.setup();
    renderSettings("agents", { agents: [agents[0]] });

    await user.click(screen.getByRole("button", { name: "Launch options" }));
    await user.type(screen.getByRole("textbox", { name: "Extra arguments for Claude Code" }), "--model opus");
    await user.tab();
    expect(usePreferencesStore.getState().agentLaunch.claude).toEqual({ args: "--model opus", env: "" });
    expect(screen.getByRole("button", { name: /Launch options\s*custom/ })).toHaveAttribute("aria-expanded", "true");

    const env = screen.getByRole("textbox", { name: "Environment variables for Claude Code" });
    expect(screen.getByText(/Used every time this agent starts/)).toBeInTheDocument();
    await user.type(env, "TERRA_X=1");
    expect(screen.getByRole("alert")).toHaveTextContent("Ignored lines (need KEY=VALUE; TERRA_ variables are reserved): TERRA_X=1");
    await user.tab();
    expect(usePreferencesStore.getState().agentLaunch.claude).toEqual({ args: "--model opus", env: "TERRA_X=1" });

    await user.click(screen.getByRole("button", { name: /Launch options/ }));
    expect(screen.queryByRole("textbox", { name: "Extra arguments for Claude Code" })).not.toBeInTheDocument();
  });

  it("Given a running MCP server, when turning it off, then the server is disabled", async () => {
    const user = userEvent.setup();
    renderSettings("agents");

    expect(await screen.findByText("Server URL: http://127.0.0.1:7777/mcp · Port 7777")).toBeInTheDocument();
    expect(screen.getByText("/tmp/terra/mcp.db")).toBeInTheDocument();
    const expose = screen.getByRole("switch", { name: "Expose Terra MCP to agents" });
    expect(expose).toHaveAttribute("aria-checked", "true");

    await user.click(expose);

    expect(ipc.mcpSetEnabled).toHaveBeenCalledWith(false);
    await waitFor(() => expect(expose).toHaveAttribute("aria-checked", "false"));
  });

  it("Given an MCP server without a port, when the agents section renders, then only the URL shows", async () => {
    ipc.mcpServerInfo.mockResolvedValue({ ...runningServer, port: null, dbPath: null });
    renderSettings("agents");

    expect(await screen.findByText("Server URL: http://127.0.0.1:7777/mcp")).toBeInTheDocument();
    expect(screen.queryByText("Database")).not.toBeInTheDocument();
  });

  it("Given an MCP server that did not start, when the agents section renders, then it says so", async () => {
    ipc.mcpServerInfo.mockResolvedValue({ ...runningServer, isRunning: false });
    renderSettings("agents");

    expect(await screen.findByText("The server did not start. Restart the app to try again.")).toBeInTheDocument();
  });

  it("Given an unavailable MCP server, when the agents section renders, then the toggle is locked and the error shows", async () => {
    ipc.mcpServerInfo.mockResolvedValue({ ...runningServer, isAvailable: false, isRunning: false, error: "disk full" });
    renderSettings("agents");

    expect(await screen.findByRole("alert")).toHaveTextContent("its database could not be opened: disk full");
    const expose = screen.getByRole("switch", { name: "Expose Terra MCP to agents" });
    expect(expose).toBeDisabled();
    expect(expose).toHaveAttribute("aria-checked", "false");
  });

  it("Given an unavailable MCP server without an error, when the agents section renders, then the message has no detail", async () => {
    ipc.mcpServerInfo.mockResolvedValue({ ...runningServer, isAvailable: false, error: null });
    renderSettings("agents");

    expect(await screen.findByRole("alert")).toHaveTextContent(/could not be opened:$/);
  });

  it("Given automatic names, when editing the name list, then the store follows every change", async () => {
    const user = userEvent.setup();
    usePreferencesStore.setState({ agentNames: { "t-1": "Vega" } });
    renderSettings("agents");

    expect(screen.queryByRole("combobox", { name: "Name list" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("switch", { name: "Name each agent when it opens" }));
    expect(usePreferencesStore.getState().shouldAutoNameAgents).toBe(true);

    expect(screen.getByText(/In use now · 1 · Free · 15 · Next one:/)).toBeInTheDocument();
    await user.selectOptions(screen.getByRole("combobox", { name: "Name list" }), "rivers");
    expect(usePreferencesStore.getState().agentNameList[0]).toBe("Xingu");

    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(usePreferencesStore.getState().agentNameSet).toBe("rivers");

    const input = screen.getByRole("textbox", { name: "Add name…" });
    await user.type(input, "  Amazonas  {Enter}");
    expect(usePreferencesStore.getState().agentNameList).toContain("Amazonas");
    expect(input).toHaveValue("");
    await user.type(input, "Tietê");
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(usePreferencesStore.getState().agentNameList.at(-1)).toBe("Tietê");

    await user.click(screen.getByRole("button", { name: "Remove Xingu" }));
    expect(usePreferencesStore.getState().agentNameList).not.toContain("Xingu");
    expect(usePreferencesStore.getState().agentNameSet).toBe("custom");

    await user.click(screen.getByRole("switch", { name: "Avoid look-alike names" }));
    expect(usePreferencesStore.getState().shouldAvoidSimilarNames).toBe(false);

    const exhausted = screen.getByRole("combobox", { name: "When the list runs out" });
    await user.selectOptions(exhausted, "repeat");
    expect(usePreferencesStore.getState().namesExhausted).toBe("repeat");
    await user.selectOptions(exhausted, "type-number");
    expect(usePreferencesStore.getState().namesExhausted).toBe("type-number");
  });

  it("Given an empty name list, when the agents section renders, then the next name is a dash", () => {
    usePreferencesStore.setState({ shouldAutoNameAgents: true, agentNameList: [], namesExhausted: "repeat" });
    renderSettings("agents");

    expect(screen.getByText("In use now · 0 · Free · 0 · Next one: —")).toBeInTheDocument();
  });
});

describe("SettingsSectionPanel shortcuts", () => {
  it("Given the shortcut list, when capturing and restoring, then the host is told", async () => {
    const user = userEvent.setup();
    const { props } = renderSettings("shortcuts", { capturing: "newWorkspace" });

    expect(screen.getByText("Press the shortcut…")).toBeInTheDocument();
    const row = screen.getByText("New agent").closest("div");
    if (!row) throw new Error("shortcut row not rendered");
    await user.click(within(row).getByRole("button"));
    expect(props.onCaptureHotkey).toHaveBeenCalledWith("newTerminal");

    await user.click(screen.getByRole("button", { name: "Restore defaults" }));
    expect(props.onResetHotkeys).toHaveBeenCalled();
  });
});

describe("SettingsSectionPanel data", () => {
  it("Given no running transfer, when exporting and importing, then the host is told", async () => {
    const user = userEvent.setup();
    const { props } = renderSettings("data");

    await user.click(screen.getByRole("button", { name: "Export snapshot" }));
    await user.click(screen.getByRole("button", { name: "Import snapshot" }));

    expect(props.onExportSnapshot).toHaveBeenCalled();
    expect(props.onImportSnapshot).toHaveBeenCalled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("Given an export in progress that saved a file, when the data section renders, then both buttons wait and the file is shown", () => {
    renderSettings("data", {
      snapshotOperation: "exporting",
      snapshotFeedback: { kind: "success", message: "Exported", backupPath: "/tmp/snap.json", pathKind: "file" },
    });

    expect(screen.getByRole("button", { name: "Exporting…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Import snapshot" })).toBeDisabled();
    expect(screen.getByText("Exported").parentElement).toHaveTextContent("File: /tmp/snap.json");
  });

  it("Given an import that failed with a backup, when the data section renders, then the error and backup are shown", () => {
    renderSettings("data", {
      snapshotOperation: "importing",
      snapshotFeedback: { kind: "error", message: "Invalid snapshot", backupPath: "/tmp/backup.json", pathKind: "backup" },
    });

    expect(screen.getByRole("button", { name: "Importing…" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("Invalid snapshotBackup: /tmp/backup.json");
  });

  it("Given feedback without a path, when the data section renders, then only the message shows", () => {
    renderSettings("data", { snapshotFeedback: { kind: "success", message: "Imported" } });

    expect(screen.getByText("Imported").parentElement).toHaveTextContent(/^Imported$/);
  });
});

describe("SettingsSectionPanel about", () => {
  it("Given an available update, when installing it, then the host is told", async () => {
    const user = userEvent.setup();
    const { props } = renderSettings("about", { updateVersion: "1.5.0" });

    expect(screen.getByText("1.4.0")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Update now" }));

    expect(props.onInstallUpdate).toHaveBeenCalled();
  });

  it("Given an update being installed and no known version, when the about section renders, then it waits", () => {
    renderSettings("about", { appVersion: "", updateVersion: "1.5.0", isUpdateInstalling: true });

    expect(screen.getByText("unknown")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Installing…" })).toBeDisabled();
  });

  it.each([
    ["idle", "Checks automatically every hour"],
    ["uptodate", "You're up to date"],
    ["error", "Couldn't check"],
  ] as const)("Given the %s check state, when checking manually, then the host checks again", async (state, label) => {
    const user = userEvent.setup();
    const { props } = renderSettings("about", { updateCheckState: state });

    expect(screen.getByText(label)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Check now" }));

    expect(props.onManualUpdateCheck).toHaveBeenCalled();
  });

  it("Given a check in progress, when the about section renders, then checking again is blocked", () => {
    renderSettings("about", { updateCheckState: "checking" });

    expect(screen.getByText("Checking for updates…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check now" })).toBeDisabled();
  });
});

describe("SettingsSectionPanel navigation", () => {
  it("Given the dialog on one section, when the user opens another tab, then its panel renders", async () => {
    const user = userEvent.setup();
    renderSettings("general");

    await user.click(screen.getByRole("tab", { name: "About" }));

    expect(screen.getByRole("heading", { name: "About" })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(screen.getByRole("searchbox", { name: "Search settings" })).toHaveFocus();
  });
});
