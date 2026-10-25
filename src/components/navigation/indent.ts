const ROW_INSET_PX = 8;
const INDENT_PER_LEVEL_PX = 16;
const MESSAGE_EXTRA_INSET_PX = 4;

export function indentFor(depth: number): string {
  return `${ROW_INSET_PX + depth * INDENT_PER_LEVEL_PX}px`;
}

export function messageIndentFor(depth: number): string {
  return `${ROW_INSET_PX + MESSAGE_EXTRA_INSET_PX + depth * INDENT_PER_LEVEL_PX}px`;
}
