// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useLocaleStore } from "../../../i18n";
import { WorkspaceDialog, type WorkspaceDialogProps } from "./WorkspaceDialog";

function dialogProps(overrides: Partial<WorkspaceDialogProps> = {}): WorkspaceDialogProps {
  return {
    isOpen: true,
    onOpenChange: vi.fn(),
    name: "",
    cwd: "",
    onNameChange: vi.fn(),
    onCwdChange: vi.fn(),
    onBrowse: vi.fn(),
    onSubmit: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  useLocaleStore.setState({ locale: "en" });
});

describe("WorkspaceDialog fields", () => {
  it("Given the form inside a group, when filling it and browsing, then each field and the folder picker are reported", async () => {
    const user = userEvent.setup();
    const props = dialogProps({ groupName: "Core" });
    render(<WorkspaceDialog {...props} />);

    expect(screen.getByText("Will be created in the group “Core”.")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Name"), "a");
    await user.type(screen.getByLabelText(/Working folder/), "/");
    await user.click(screen.getByRole("button", { name: "Browse" }));

    expect(props.onNameChange).toHaveBeenCalledWith("a");
    expect(props.onCwdChange).toHaveBeenCalledWith("/");
    expect(props.onBrowse).toHaveBeenCalledTimes(1);
  });

  it("Given a rejected empty name, when the dialog closes and reopens, then the error is gone", async () => {
    const user = userEvent.setup();
    const props = dialogProps();
    const { rerender } = render(<WorkspaceDialog {...props} />);

    await user.click(screen.getByRole("button", { name: "Create workspace" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a name for the workspace.");
    expect(props.onSubmit).not.toHaveBeenCalled();

    rerender(<WorkspaceDialog {...props} isOpen={false} />);
    rerender(<WorkspaceDialog {...props} />);

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("You can rename it later.")).toBeInTheDocument();
  });

  it("Given a named workspace, when creating it, then it is submitted", async () => {
    const user = userEvent.setup();
    const props = dialogProps({ name: "Terra API" });
    render(<WorkspaceDialog {...props} />);

    await user.click(screen.getByRole("button", { name: "Create workspace" }));

    expect(props.onSubmit).toHaveBeenCalledTimes(1);
  });
});
