import { describe, expect, it } from "vitest";
import { IpcError, isIpcError, toIpcError } from "./errors";

describe("toIpcError", () => {
  it("given a coded rejection, returns an IpcError with its code, message and cause", () => {
    const payload = { code: "changedOnDisk", message: "the file changed on disk" };
    const error = toIpcError(payload);
    expect(error).toBeInstanceOf(IpcError);
    expect(error).toMatchObject({ code: "changedOnDisk", message: "the file changed on disk", cause: payload });
  });

  it("given a plain message, returns it unchanged", () => {
    expect(toIpcError("terminal t-1 not found")).toBe("terminal t-1 not found");
  });

  it("given an object with an unknown code or no message, returns it unchanged", () => {
    const unknownCode = { code: "exploded", message: "no" };
    const noMessage = { code: "busy" };
    expect(toIpcError(unknownCode)).toBe(unknownCode);
    expect(toIpcError(noMessage)).toBe(noMessage);
    expect(toIpcError(null)).toBeNull();
  });
});

describe("isIpcError", () => {
  it("given an IpcError with the code, matches it", () => {
    expect(isIpcError(new IpcError({ code: "busy", message: "input busy" }), "busy")).toBe(true);
  });

  it("given another code, a plain Error or a message that names the code, does not match", () => {
    expect(isIpcError(new IpcError({ code: "other", message: "input closed" }), "busy")).toBe(false);
    expect(isIpcError(new Error("terminal input busy"), "busy")).toBe(false);
    expect(isIpcError("terminal input busy", "busy")).toBe(false);
  });
});
