export function initials(name: string): string {
  const words = name.split(/[\s_.-]+/).filter(Boolean);
  if (words.length >= 2) return `${words[0][0]}${words[1][0]}`.toLowerCase();
  return name.slice(0, 2).toLowerCase();
}
