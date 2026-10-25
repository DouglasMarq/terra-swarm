import { normalizeSearchText } from "../lib/text/normalizeSearchText";

export type VoiceIntent =
  | { type: "focus"; target: string }
  | { type: "open-fleet" }
  | { type: "suspend-group"; group: string }
  | { type: "resume-group"; group: string }
  | { type: "new-agent"; agent?: string };

const UNSAFE_TARGET = /[\u0000-\u001f\u007f;&|`$<>]/;
const MAX_TARGET_CHARS = 128;
const MAX_TRANSCRIPT_CHARS = 512;

export function normalizeVoiceText(raw: string): string {
  return normalizeSearchText(raw.replace(/[!?.,:]+$/g, "").replace(/\s+/g, " "));
}

function safeTarget(raw: string | undefined): string | null {
  if (!raw) return null;
  const target = raw
    .trim()
    .replace(/^["']/, "")
    .replace(/["']$/, "")
    .trim();
  if (!target || target.length > MAX_TARGET_CHARS || UNSAFE_TARGET.test(target)) return null;
  return target;
}

function matchTarget(
  source: string,
  patterns: readonly RegExp[],
): string | null | undefined {
  for (const pattern of patterns) {
    const match = pattern.exec(source);
    if (match) return safeTarget(match[1]);
  }
  return undefined;
}

export function parseVoiceCommand(input: unknown): VoiceIntent | null {
  if (typeof input !== "string" || input.length > MAX_TRANSCRIPT_CHARS) return null;
  let source = normalizeVoiceText(input);
  source = source.replace(/^(?:por favor|please)[,\s]+/, "");
  if (!source) return null;

  if (/^(?:abrir|mostrar|exibir|ver) (?:a |o )?frota$/.test(source)) {
    return { type: "open-fleet" };
  }
  if (/^(?:open|show|view) (?:the )?fleet$/.test(source)) {
    return { type: "open-fleet" };
  }

  const focus = matchTarget(source, [
    /^(?:focar|foco|selecionar|selecione)(?: (?:o |a |no |na |em )?terminal)? (.+)$/,
    /^(?:focus|select)(?: (?:the )?terminal)? (.+)$/,
  ]);
  if (focus !== undefined) {
    return focus ? { type: "focus", target: focus } : null;
  }

  const suspend = matchTarget(source, [
    /^(?:suspender|pausar|pause)(?: (?:o |a )?grupo) (.+)$/,
    /^(?:suspend)(?: (?:the )?group) (.+)$/,
  ]);
  if (suspend !== undefined) {
    return suspend ? { type: "suspend-group", group: suspend } : null;
  }

  const resume = matchTarget(source, [
    /^(?:retomar|continuar)(?: (?:o |a )?grupo) (.+)$/,
    /^(?:resume|continue)(?: (?:the )?group) (.+)$/,
  ]);
  if (resume !== undefined) {
    return resume ? { type: "resume-group", group: resume } : null;
  }

  for (const pattern of [
    /^(?:novo agente|criar agente|iniciar agente)(?: (.+))?$/,
    /^(?:criar um novo agente|startar um novo agente)(?: (.+))?$/,
    /^(?:new agent|create agent|start agent)(?: (.+))?$/,
    /^(?:create a new agent|start a new agent)(?: (.+))?$/,
  ]) {
    const match = pattern.exec(source);
    if (match) {
      const agent = safeTarget(match[1]);
      if (match[1] && !agent) return null;
      return agent ? { type: "new-agent", agent } : { type: "new-agent" };
    }
  }

  return null;
}

