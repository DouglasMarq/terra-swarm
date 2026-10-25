import type { AgentLaunchExtras } from "./agent.model";

export interface AgentLaunchSettings {
  args: string;
  env: string;
}

/** Parse `KEY=VALUE` lines; blank lines and `#` comments are skipped. */
export function parseEnvLines(text: string): { env: Record<string, string>; invalid: string[] } {
  const env: Record<string, string> = {};
  const invalid: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    const key = separator > 0 ? line.slice(0, separator).trim() : "";
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || key.startsWith("TERRA_")) {
      invalid.push(line);
      continue;
    }
    env[key] = line.slice(separator + 1).trim();
  }
  return { env, invalid };
}

export function launchExtrasFrom(settings: AgentLaunchSettings | undefined): AgentLaunchExtras | undefined {
  if (!settings) return undefined;
  return { args: settings.args.trim() || undefined, env: parseEnvLines(settings.env).env };
}
