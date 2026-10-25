/** What to write for `prompt`: a bracketed paste when the terminal asked for one. */
export function promptPayload(prompt: string, bracketed: boolean): string {
  const text = prompt.replace(/\r?\n/g, bracketed ? "\n" : " ");
  return bracketed ? `\u001b[200~${text}\u001b[201~` : text;
}
