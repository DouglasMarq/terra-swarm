// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const preview = vi.hoisted(() => ({ probeDevServers: vi.fn() }));

vi.mock("../../lib/tauri/preview", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/tauri/preview")>()),
  previewApi: preview,
}));

import { useLocaleStore } from "../../i18n";
import { useMcpStore } from "../../stores/mcpStore";
import { usePreviewStore } from "../../stores/previewStore";
import { PreviewPanel } from "./PreviewPanel";

beforeEach(() => {
  useLocaleStore.setState({ locale: "en" });
  usePreviewStore.getState().reset();
  useMcpStore.setState({ server: null });
  preview.probeDevServers.mockReset().mockResolvedValue([]);
});

describe("PreviewPanel", () => {
  it("Given no project, when the panel renders, then it asks for one and does not scan", () => {
    render(<PreviewPanel workspaceId={null} />);

    expect(screen.getByText("Open a project to preview its dev server.")).toBeInTheDocument();
    expect(preview.probeDevServers).not.toHaveBeenCalled();
  });

  it("Given a running dev server, when the panel opens, then it scans once, skipping the MCP port, and shows the page", async () => {
    useMcpStore.setState({
      server: { isEnabled: true, isAvailable: true, isRunning: true, url: "http://127.0.0.1:8080/mcp", port: 8080, dbPath: null, error: null },
    });
    preview.probeDevServers.mockResolvedValue([5173]);
    const view = render(<PreviewPanel workspaceId="ws-1" />);

    const frame = await screen.findByTitle("Preview of http://localhost:5173/");
    expect(frame).toHaveAttribute("src", "http://localhost:5173/");
    expect(preview.probeDevServers).toHaveBeenCalledTimes(1);
    expect(preview.probeDevServers.mock.calls[0][0]).not.toContain(8080);
    expect(screen.getByRole("combobox", { name: "Address of the local page" })).toHaveValue("http://localhost:5173/");
    expect(view.container.querySelectorAll("datalist option")).toHaveLength(1);
  });

  it("Given no dev server, when the scan ends, then the panel explains how to get one", async () => {
    let finishProbe: (ports: number[]) => void = () => undefined;
    preview.probeDevServers.mockReturnValue(new Promise<number[]>((resolve) => { finishProbe = resolve; }));
    render(<PreviewPanel workspaceId="ws-1" />);

    expect(await screen.findByText("Looking for a dev server on this machine…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Look for local dev servers" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reload" })).toBeDisabled();

    finishProbe([]);
    expect(await screen.findByText(/No dev server found/)).toBeInTheDocument();
  });

  it("Given an address outside this machine, when opening it, then it is refused", async () => {
    const user = userEvent.setup();
    render(<PreviewPanel workspaceId="ws-1" />);
    const address = screen.getByRole("combobox", { name: "Address of the local page" });

    await user.type(address, "example.com{Enter}");

    expect(screen.getByRole("alert")).toHaveTextContent("Only pages on this machine (localhost) can open here.");
    expect(address).toHaveAttribute("aria-invalid", "true");
    await user.type(address, "x");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("Given a port, when opening it and reloading, then the page loads from localhost again", async () => {
    const user = userEvent.setup();
    render(<PreviewPanel workspaceId="ws-1" />);

    await user.type(screen.getByRole("combobox", { name: "Address of the local page" }), "4321{Enter}");
    const frame = screen.getByTitle("Preview of http://localhost:4321/");
    expect(usePreviewStore.getState().selected["ws-1"]).toBe("http://localhost:4321/");

    await user.click(screen.getByRole("button", { name: "Reload" }));
    expect(screen.getByTitle("Preview of http://localhost:4321/")).not.toBe(frame);
  });

  it("Given the panel, when scanning again, then newly found servers are offered", async () => {
    const user = userEvent.setup();
    render(<PreviewPanel workspaceId="ws-1" />);
    await waitFor(() => expect(usePreviewStore.getState().isProbing).toBe(false));

    preview.probeDevServers.mockResolvedValue([8000]);
    await user.click(screen.getByRole("button", { name: "Look for local dev servers" }));

    expect(await screen.findByTitle("Preview of http://localhost:8000/")).toBeInTheDocument();
    expect(preview.probeDevServers).toHaveBeenCalledTimes(2);
  });
});
