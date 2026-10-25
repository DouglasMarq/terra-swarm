// @vitest-environment jsdom

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentLabel } from "../../domain/agentLabels";
import type { NotificationItem } from "../../domain/notification.model";
import { translateNow, useLocaleStore } from "../../i18n";
import { NotificationCenter, relativeTime, type NotificationCenterProps } from "./NotificationCenter";

const NOW = Date.UTC(2026, 9, 25, 12, 0, 0);
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const labels: Record<string, AgentLabel> = {
  "term-codex": { terminalId: "term-codex", workspaceId: "ws-api", kind: "codex", tag: "codex", title: null, name: "Amazonas", primary: "Amazonas" },
};

const items: NotificationItem[] = [
  { key: 1, terminalId: "term-codex", workspaceId: "ws-api", message: "Old question", ts: NOW - 2 * HOUR_MS, isRead: false },
  { key: 2, terminalId: "term-codex", workspaceId: "ws-api", message: "May I run npm test?", ts: NOW - 10 * MINUTE_MS, isRead: false },
  { key: 3, terminalId: "term-ghost", workspaceId: "ws-gone", message: "Finished the refactor", ts: NOW - 3 * HOUR_MS, isRead: true },
  { key: 4, terminalId: "", workspaceId: "", message: "Update available", ts: NOW - 2 * DAY_MS, isRead: false, isSystem: true },
];

function renderCenter(overrides: Partial<NotificationCenterProps> = {}) {
  const props: NotificationCenterProps = {
    items,
    labels,
    workspaceNames: { "ws-api": "Terra API" },
    isMuted: false,
    onJump: vi.fn(),
    onFocusAgent: vi.fn(),
    onMarkRead: vi.fn(),
    onMarkAllRead: vi.fn(),
    onToggleMute: vi.fn(),
    onOpenFleet: vi.fn(),
    now: NOW,
    ...overrides,
  };
  render(<NotificationCenter {...props} />);
  return props;
}

beforeEach(() => {
  useLocaleStore.setState({ locale: "en" });
});

describe("relativeTime", () => {
  it("Given timestamps of different ages, when formatting them, then they read as now, minutes, hours or a date", () => {
    expect(relativeTime(NOW - 10_000, translateNow, NOW)).toBe("now");
    expect(relativeTime(NOW - 5 * MINUTE_MS, translateNow, NOW)).toBe("5 min");
    expect(relativeTime(NOW - 3 * HOUR_MS, translateNow, NOW)).toBe("3 h");
    expect(relativeTime(NOW - 3 * DAY_MS, translateNow, NOW)).toMatch(/22/);
  });
});

describe("NotificationCenter", () => {
  it("Given an agent waiting, when the center opens, then it lists only its latest request and the read history below", () => {
    renderCenter();

    const center = screen.getByRole("dialog", { name: "Notifications" });
    expect(within(center).getByRole("button", { name: "Needs you · 1" })).toHaveAttribute("aria-pressed", "true");
    expect(within(center).getByRole("button", { name: "All · 4" })).toBeInTheDocument();
    const card = within(center).getByText("May I run npm test?").closest("article");
    if (!card) throw new Error("the pending request has no card");
    expect(card).toHaveTextContent("Amazonas");
    expect(card).toHaveTextContent("codex · Terra API");
    expect(card).toHaveTextContent("10 min");
    expect(within(center).queryByText("Old question")).not.toBeInTheDocument();
    expect(within(center).getByText("Earlier · read")).toBeInTheDocument();
    expect(within(center).getByRole("button", { name: /Agent Finished the refactor/ })).toHaveTextContent("3 h");
    expect(within(center).getByRole("button", { name: /Update available/ })).toHaveTextContent("Terra Swarm");
  });

  it("Given a pending request, when acting on its card, then it jumps to the pane or marks it read", async () => {
    const user = userEvent.setup();
    const props = renderCenter();

    await user.click(screen.getByRole("button", { name: "Go to pane" }));
    expect(props.onJump).toHaveBeenCalledWith(items[1]);

    await user.click(screen.getByRole("button", { name: "Mark as read" }));
    expect(props.onMarkRead).toHaveBeenCalledWith("term-codex");

    await user.click(screen.getByRole("button", { name: "Mark all as read" }));
    expect(props.onMarkAllRead).toHaveBeenCalled();
  });

  it("Given the history, when switching to all and opening a row, then every item is listed as recent and the row jumps", async () => {
    const user = userEvent.setup();
    const props = renderCenter();

    await user.click(screen.getByRole("button", { name: "All · 4" }));

    expect(screen.getByText("Recent")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Go to pane" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Old question/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /May I run npm test\?/ }));
    expect(props.onJump).toHaveBeenCalledWith(items[1]);
  });

  it("Given a context alert for an agent without a request, when going to its pane, then that agent is focused", async () => {
    const user = userEvent.setup();
    const props = renderCenter({
      items: [],
      contextAlerts: [
        { terminalId: "term-codex", workspaceId: "ws-api", used: 91 },
        { terminalId: "term-ghost", workspaceId: "ws-gone", used: 88 },
      ],
    });

    expect(screen.getByRole("button", { name: "Needs you · 2" })).toBeInTheDocument();
    expect(screen.getByText(/Context at 91%/)).toBeInTheDocument();
    const ghost = screen.getByText(/Context at 88%/).closest("article");
    if (!ghost) throw new Error("the context alert has no card");
    expect(ghost).toHaveTextContent("Agentagent");

    await user.click(screen.getAllByRole("button", { name: "Go to pane" })[0]);
    expect(props.onFocusAgent).toHaveBeenCalledWith("term-codex");
    expect(screen.getByRole("button", { name: "Mark all as read" })).toBeDisabled();
  });

  it("Given a context alert and no focus handler, when the center renders, then the alert has no action", () => {
    renderCenter({ items: [], contextAlerts: [{ terminalId: "term-codex", workspaceId: "ws-api", used: 91 }], onFocusAgent: undefined });

    expect(screen.getByText(/Context at 91%/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Go to pane" })).not.toBeInTheDocument();
  });

  it("Given a context alert for an agent that already asked, when the center renders, then only the request is counted", () => {
    renderCenter({ contextAlerts: [{ terminalId: "term-codex", workspaceId: "ws-api", used: 91 }] });

    expect(screen.getByRole("button", { name: "Needs you · 1" })).toBeInTheDocument();
    expect(screen.queryByText(/Context at 91%/)).not.toBeInTheDocument();
  });

  it("Given nothing waiting, when the center opens, then it starts on all and the attention tab is empty", async () => {
    const user = userEvent.setup();
    renderCenter({ items: [] });

    expect(screen.getByRole("button", { name: "All · 0" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByText("No agent is waiting for you.")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Needs you · 0" }));
    expect(screen.getByText("No agent is waiting for you.")).toBeInTheDocument();
  });

  it("Given the footer, when opening the fleet and toggling mute, then both handlers run", async () => {
    const user = userEvent.setup();
    const props = renderCenter({ isMuted: true });

    await user.click(screen.getByRole("button", { name: "See everything in the Fleet →" }));
    await user.click(screen.getByRole("button", { name: "Unmute" }));

    expect(props.onOpenFleet).toHaveBeenCalled();
    expect(props.onToggleMute).toHaveBeenCalled();
  });
});
