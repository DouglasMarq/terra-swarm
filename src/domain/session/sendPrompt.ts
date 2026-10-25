export function promptPayload(prompt: string, isBracketed: boolean): string {
  const text = prompt.replace(/\r?\n/g, isBracketed ? "\n" : " ");
  return isBracketed ? `\u001b[200~${text}\u001b[201~` : text;
}
