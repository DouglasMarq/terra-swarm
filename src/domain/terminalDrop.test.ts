import { describe, expect, it } from "vitest";
import { detectDropPlatform, dropPointToClient, formatDroppedPaths } from "./terminalDrop";

describe("formatDroppedPaths", () => {
  it("Given a plain path on macOS, when formatting the drop, then it is pasted followed by a space", () => {
    expect(formatDroppedPaths(["/Users/me/shot.png"], "mac")).toBe("/Users/me/shot.png ");
  });

  it("Given a path with spaces and shell characters on macOS, when formatting the drop, then they are backslash-escaped", () => {
    expect(formatDroppedPaths(["/Users/me/Screen Shot (1)'s $x.png"], "mac")).toBe(
      "/Users/me/Screen\\ Shot\\ \\(1\\)\\'s\\ \\$x.png ",
    );
  });

  it("Given a path with accents on Linux, when formatting the drop, then they stay unescaped", () => {
    expect(formatDroppedPaths(["/home/me/Captura de tela ção.png"], "linux")).toBe(
      "/home/me/Captura\\ de\\ tela\\ ção.png ",
    );
  });

  it("Given several files, when formatting the drop, then they are separated with spaces", () => {
    expect(formatDroppedPaths(["/Users/me/a.png", "/Users/me/b.png"], "mac")).toBe("/Users/me/a.png /Users/me/b.png ");
  });

  it("Given a Windows path with spaces, when formatting the drop, then it is wrapped in double quotes", () => {
    expect(formatDroppedPaths(["C:\\Users\\me\\My Pictures\\shot.png"], "windows")).toBe(
      "\"C:\\Users\\me\\My Pictures\\shot.png\" ",
    );
  });

  it("Given a plain Windows path, when formatting the drop, then it is pasted as is", () => {
    expect(formatDroppedPaths(["C:\\Users\\me\\shot.png"], "windows")).toBe("C:\\Users\\me\\shot.png ");
  });

  it("Given a path with a newline, when formatting the drop, then it is left out so it cannot submit the input", () => {
    expect(formatDroppedPaths(["/Users/me/evil\nrm.png", "/Users/me/ok.png"], "mac")).toBe("/Users/me/ok.png ");
  });

  it("Given no usable paths, when formatting the drop, then there is nothing to paste", () => {
    expect(formatDroppedPaths([], "mac")).toBe("");
    expect(formatDroppedPaths(["", "/Users/me/\u0003.png"], "linux")).toBe("");
  });
});

describe("dropPointToClient", () => {
  it("Given Windows, when converting the drop point, then device pixels become CSS pixels", () => {
    expect(dropPointToClient({ x: 300, y: 150 }, "windows", 1.5)).toEqual({ x: 200, y: 100 });
  });

  it("Given macOS or Linux, when converting the drop point, then the position is kept as it is already in CSS pixels", () => {
    expect(dropPointToClient({ x: 300, y: 150 }, "mac", 2)).toEqual({ x: 300, y: 150 });
    expect(dropPointToClient({ x: 300, y: 150 }, "linux", 2)).toEqual({ x: 300, y: 150 });
  });
});

describe("detectDropPlatform", () => {
  it("Given each desktop user agent, when detecting the drop platform, then its platform is named", () => {
    expect(detectDropPlatform({ platform: "MacIntel", userAgent: "Mozilla/5.0 (Macintosh)" })).toBe("mac");
    expect(detectDropPlatform({ platform: "Win32", userAgent: "Mozilla/5.0 (Windows NT 10.0)" })).toBe("windows");
    expect(detectDropPlatform({ platform: "Linux x86_64", userAgent: "Mozilla/5.0 (X11; Linux x86_64)" })).toBe("linux");
  });
});
