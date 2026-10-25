import { describe, expect, it } from "vitest";
import { IpcError, isIpcError, toIpcError } from "./errors";

describe("toIpcError", () => {
  it("Given a coded rejection, when converting it, then an IpcError with its code, message and cause is returned", () => {
    const payload = { code: "changedOnDisk", message: "the file changed on disk" };
    const error = toIpcError(payload);
    expect(error).toBeInstanceOf(IpcError);
    expect(error).toMatchObject({ code: "changedOnDisk", message: "the file changed on disk", cause: payload });
  });

  it("Given a plain message, when converting it, then it is returned unchanged", () => {
    expect(toIpcError("terminal t-1 not found")).toBe("terminal t-1 not found");
  });

  it("Given an object with an unknown code or no message, when converting it, then it is returned unchanged", () => {
    const unknownCode = { code: "exploded", message: "no" };
    const noMessage = { code: "busy" };
    expect(toIpcError(unknownCode)).toBe(unknownCode);
    expect(toIpcError(noMessage)).toBe(noMessage);
    expect(toIpcError(null)).toBeNull();
  });
});

describe("isIpcError", () => {
  it("Given an IpcError with the code, when checking it, then it matches", () => {
    expect(isIpcError(new IpcError({ code: "busy", message: "input busy" }), "busy")).toBe(true);
  });

  it("Given another code, a plain Error or a message that names the code, when checking it, then it does not match", () => {
    expect(isIpcError(new IpcError({ code: "other", message: "input closed" }), "busy")).toBe(false);
    expect(isIpcError(new Error("terminal input busy"), "busy")).toBe(false);
    expect(isIpcError("terminal input busy", "busy")).toBe(false);
  });
});
