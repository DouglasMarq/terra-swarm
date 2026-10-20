import { getTerminal } from "../terminalRegistry";
import { writeTerminal } from "../lib/tauri/pty";
import { promptPayload } from "../lib/session/sendPrompt";

/** Gap between the paste and Enter, so TUIs treat the text as one paste. */
const SUBMIT_DELAY_MS = 120;

/**
 * Type `prompt` into an agent's terminal and press Enter. Agent CLIs turn on
 * bracketed paste; when the terminal is not mounted yet we assume they did.
 */
export async function sendPromptToTerminal(
  terminalId: string,
  prompt: string,
  options: { submit?: boolean; write?: (id: string, data: string) => Promise<void> } = {},
): Promise<void> {
  const write = options.write ?? writeTerminal;
  const bracketed = getTerminal(terminalId)?.modes.bracketedPasteMode ?? true;
  await write(terminalId, promptPayload(prompt, bracketed));
  if (options.submit === false) return;
  await new Promise((resolve) => setTimeout(resolve, SUBMIT_DELAY_MS));
  await write(terminalId, "\r");
}
