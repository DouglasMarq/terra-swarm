import { getTerminal } from "../terminalRegistry";
import { writeTerminal } from "../lib/tauri/pty";
import { promptPayload } from "../domain/session/sendPrompt";
import type { McpNudgePayload } from "../lib/tauri/mcp";

const SUBMIT_DELAY_MS = 120;

export async function sendPromptToTerminal(
  terminalId: string,
  prompt: string,
  options: { shouldSubmit?: boolean; write?: (id: string, data: string) => Promise<void> } = {},
): Promise<void> {
  const write = options.write ?? writeTerminal;
  const isBracketed = getTerminal(terminalId)?.modes.bracketedPasteMode ?? true;
  await write(terminalId, promptPayload(prompt, isBracketed));
  if (options.shouldSubmit === false) return;
  await new Promise((resolve) => setTimeout(resolve, SUBMIT_DELAY_MS));
  await write(terminalId, "\r");
}

export function nudgeAgent(payload: McpNudgePayload): void {
  void sendPromptToTerminal(payload.terminal_id, payload.prompt).catch((error) =>
    console.warn(`failed to wake ${payload.terminal_id}:`, error),
  );
}
