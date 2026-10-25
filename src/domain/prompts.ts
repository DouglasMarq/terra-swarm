export interface SavedPrompt {
  id: string;
  title: string;
  body: string;
}

const DERIVED_TITLE_WORDS = 6;
const FALLBACK_TITLE = "Prompt";

export function fillPrompt(body: string, values: { project?: string | null }): string {
  return body.replace(/\{project\}/g, values.project?.trim() || "this project");
}

export function promptTitle(title: string, body: string): string {
  return title.trim() || body.trim().split(/\s+/).slice(0, DERIVED_TITLE_WORDS).join(" ") || FALLBACK_TITLE;
}
