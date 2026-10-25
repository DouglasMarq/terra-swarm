import { describe, expect, it } from "vitest";
import { parseEnvLines } from "./agentLaunchEnv";

describe("parseEnvLines", () => {
  it("parses KEY=VALUE lines and reports the rest", () => {
    const { env, invalid } = parseEnvLines("# comment\nANTHROPIC_MODEL = opus\n\nFOO=a=b\nnot valid\nTERRA_PANE_ID=x\n1BAD=y");
    expect(env).toEqual({ ANTHROPIC_MODEL: "opus", FOO: "a=b" });
    expect(invalid).toEqual(["not valid", "TERRA_PANE_ID=x", "1BAD=y"]);
  });
});
