import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { invokeCommand } from "./commands";
import { IpcError } from "./errors";

describe("invokeCommand", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("Given a command that rejects with a code, when invoking it, then it rejects with an IpcError", async () => {
    invoke.mockRejectedValue({ code: "busy", message: "terminal t-1 input busy" });
    const failure = await invokeCommand("writeTerminal", { id: "t-1", data: "a" }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(IpcError);
    expect(failure).toMatchObject({ code: "busy", message: "terminal t-1 input busy" });
    expect(invoke).toHaveBeenCalledWith("write_terminal", { id: "t-1", data: "a" });
  });

  it("Given a command that rejects with a plain message, when invoking it, then it rejects with that message", async () => {
    invoke.mockRejectedValue("no workspace with id ws-9");
    await expect(invokeCommand("listWorkspaces")).rejects.toBe("no workspace with id ws-9");
  });

  it("Given a command that succeeds, when invoking it, then it resolves to its result", async () => {
    invoke.mockResolvedValue([]);
    await expect(invokeCommand("listWorkspaces")).resolves.toEqual([]);
    expect(invoke).toHaveBeenCalledWith("list_workspaces");
  });
});
