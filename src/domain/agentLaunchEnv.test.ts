import { describe, expect, it } from "vitest";
import { launchExtrasFrom, parseEnvLines } from "./agentLaunchEnv";

describe("parseEnvLines", () => {
  it("Given environment lines, when parsing them, then KEY=VALUE lines are parsed and the rest is reported", () => {
    const { env, invalid } = parseEnvLines("# comment\nANTHROPIC_MODEL = opus\n\nFOO=a=b\nnot valid\nTERRA_PANE_ID=x\n1BAD=y");
    expect(env).toEqual({ ANTHROPIC_MODEL: "opus", FOO: "a=b" });
    expect(invalid).toEqual(["not valid", "TERRA_PANE_ID=x", "1BAD=y"]);
  });
});

describe("launchExtrasFrom", () => {
  it("Given launch settings, when building the extras, then the args are trimmed and the valid variables parsed", () => {
    expect(launchExtrasFrom({ args: "  --verbose ", env: "MODE=fast\nbad line" })).toEqual({
      args: "--verbose",
      env: { MODE: "fast" },
    });
  });

  it("Given blank args, when building the extras, then no args are sent", () => {
    expect(launchExtrasFrom({ args: "   ", env: "" })).toEqual({ args: undefined, env: {} });
  });

  it("Given no settings, when building the extras, then there are none", () => {
    expect(launchExtrasFrom(undefined)).toBeUndefined();
  });
});
