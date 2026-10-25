// @vitest-environment jsdom

import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useLocaleStore } from "../../i18n";
import { VoiceTargetPicker, type VoiceTargetProject } from "./VoiceTargetPicker";

const projects: VoiceTargetProject[] = [
  {
    id: "ws-api",
    name: "Terra API",
    agents: [
      { id: "term-codex", primary: "Amazonas", tag: "codex", status: "working", detail: "Running tests" },
      { id: "term-claude", primary: "Xingu", tag: "claude", status: "exited", detail: "Done" },
    ],
  },
  {
    id: "ws-web",
    name: "Terra Web",
    agents: [{ id: "term-shell", primary: "shell", tag: "shell", status: "suspended", detail: "Paused" }],
  },
];

function renderPicker(targetId: string | null) {
  const onChange = vi.fn();
  const view = render(
    <div>
      <VoiceTargetPicker projects={projects} targetId={targetId} onChange={onChange} />
      <button type="button">Outside</button>
    </div>,
  );
  return { onChange, view };
}

beforeEach(() => {
  useLocaleStore.setState({ locale: "en" });
});

describe("VoiceTargetPicker", () => {
  it("Given a running target, when the picker renders, then the chip names it and the list stays closed", () => {
    renderPicker("term-codex");

    const chip = screen.getByRole("button", { name: "Amazonas · codex" });
    expect(chip).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.queryByText("Resumes before sending")).not.toBeInTheDocument();
  });

  it("Given no target, when the picker renders, then it says no agent is selected", () => {
    renderPicker(null);

    expect(screen.getByRole("button", { name: "No agent selected" })).toBeInTheDocument();
  });

  it("Given an exited target, when the picker renders, then it warns that the agent resumes first", () => {
    renderPicker("term-claude");

    expect(screen.getByText("Resumes before sending")).toBeInTheDocument();
  });

  it("Given the open list, when picking another agent, then it becomes the target and the list closes", async () => {
    const user = userEvent.setup();
    const { onChange } = renderPicker("term-codex");

    await user.click(screen.getByRole("button", { name: "Amazonas · codex" }));
    const list = screen.getByRole("listbox", { name: "Send to" });
    expect(within(list).getByRole("option", { name: /Amazonas/ })).toHaveAttribute("aria-selected", "true");
    expect(within(list).getByRole("option", { name: /Xingu/ })).toHaveTextContent("Exited · resumes its last agent with this prompt");
    expect(within(list).getByRole("option", { name: /shell/ })).toBeDisabled();
    expect(within(list).getByRole("group", { name: "Terra Web" })).toBeInTheDocument();

    await user.click(within(list).getByRole("option", { name: /Xingu/ }));

    expect(onChange).toHaveBeenCalledWith("term-claude");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("Given the open list, when clicking the chip again, then it closes", async () => {
    const user = userEvent.setup();
    renderPicker("term-codex");
    const chip = screen.getByRole("button", { name: "Amazonas · codex" });

    await user.click(chip);
    expect(chip).toHaveAttribute("aria-expanded", "true");
    await user.click(chip);

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("Given the open list, when pressing Escape, then it closes without reaching outer handlers", async () => {
    const user = userEvent.setup();
    const outerKeyDown = vi.fn();
    renderPicker("term-codex");
    document.addEventListener("keydown", outerKeyDown);

    await user.click(screen.getByRole("button", { name: "Amazonas · codex" }));
    await user.keyboard("a");
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(outerKeyDown).toHaveBeenCalledTimes(1);
    document.removeEventListener("keydown", outerKeyDown);
  });

  it("Given the open list, when pressing inside it or outside, then only the outside press closes it", async () => {
    const user = userEvent.setup();
    renderPicker("term-codex");

    await user.click(screen.getByRole("button", { name: "Amazonas · codex" }));
    fireEvent.pointerDown(screen.getByRole("listbox"));
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    fireEvent.pointerDown(screen.getByRole("button", { name: "Outside" }));
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
});
