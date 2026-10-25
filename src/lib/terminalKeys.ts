export function isPlainShiftEnter(event: KeyboardEvent): boolean {
  return (
    (event.type === "keydown" || event.type === "keypress") &&
    event.key === "Enter" &&
    event.shiftKey &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey
  );
}
