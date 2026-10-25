import { describe, expect, it } from "vitest";
import { detectDropPlatform, dropPointToClient, formatDroppedPaths } from "./terminalDrop";

describe("formatDroppedPaths", () => {
  it("given a plain path on macOS, pastes it followed by a space", () => {
    expect(formatDroppedPaths(["/Users/me/shot.png"], "mac")).toBe("/Users/me/shot.png ");
  });

  it("given a path with spaces and shell characters on macOS, backslash-escapes them", () => {
    expect(formatDroppedPaths(["/Users/me/Screen Shot (1)'s $x.png"], "mac")).toBe(
      "/Users/me/Screen\\ Shot\\ \\(1\\)\\'s\\ \\$x.png ",
    );
  });

  it("given a path with accents on Linux, keeps them unescaped", () => {
    expect(formatDroppedPaths(["/home/me/Captura de tela ção.png"], "linux")).toBe(
      "/home/me/Captura\\ de\\ tela\\ ção.png ",
    );
  });

  it("given several files, separates them with spaces", () => {
    expect(formatDroppedPaths(["/Users/me/a.png", "/Users/me/b.png"], "mac")).toBe("/Users/me/a.png /Users/me/b.png ");
  });

  it("given a Windows path with spaces, wraps it in double quotes", () => {
    expect(formatDroppedPaths(["C:\\Users\\me\\My Pictures\\shot.png"], "windows")).toBe(
      "\"C:\\Users\\me\\My Pictures\\shot.png\" ",
    );
  });

  it("given a plain Windows path, pastes it as is", () => {
    expect(formatDroppedPaths(["C:\\Users\\me\\shot.png"], "windows")).toBe("C:\\Users\\me\\shot.png ");
  });

  it("given a path with a newline, leaves it out so it cannot submit the input", () => {
    expect(formatDroppedPaths(["/Users/me/evil\nrm.png", "/Users/me/ok.png"], "mac")).toBe("/Users/me/ok.png ");
  });

  it("given no usable paths, returns nothing to paste", () => {
    expect(formatDroppedPaths([], "mac")).toBe("");
    expect(formatDroppedPaths(["", "/Users/me/\u0003.png"], "linux")).toBe("");
  });
});

describe("dropPointToClient", () => {
  it("given Windows, converts device pixels to CSS pixels", () => {
    expect(dropPointToClient({ x: 300, y: 150 }, "windows", 1.5)).toEqual({ x: 200, y: 100 });
  });

  it("given macOS or Linux, keeps the position, which is already in CSS pixels", () => {
    expect(dropPointToClient({ x: 300, y: 150 }, "mac", 2)).toEqual({ x: 300, y: 150 });
    expect(dropPointToClient({ x: 300, y: 150 }, "linux", 2)).toEqual({ x: 300, y: 150 });
  });
});

describe("detectDropPlatform", () => {
  it("given each desktop user agent, names its platform", () => {
    expect(detectDropPlatform({ platform: "MacIntel", userAgent: "Mozilla/5.0 (Macintosh)" })).toBe("mac");
    expect(detectDropPlatform({ platform: "Win32", userAgent: "Mozilla/5.0 (Windows NT 10.0)" })).toBe("windows");
    expect(detectDropPlatform({ platform: "Linux x86_64", userAgent: "Mozilla/5.0 (X11; Linux x86_64)" })).toBe("linux");
  });
});
