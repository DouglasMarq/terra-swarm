# Terra visual foundation

This directory documents and implements the Terra Swarm visual direction used
by the new orchestration surfaces. It is intentionally independent from the
reference application's branding and assets: the shared pattern is a dense,
terminal-first workspace, while Terra keeps its own zinc surfaces, white
primary action, and green/amber/red status vocabulary.

`index.css` is the single entrypoint. It imports the token, low-specificity
reset, and layout primitives so the host application can adopt the foundation
incrementally. Existing shell styles may continue to coexist during migration.

## Colour tokens

Every colour, surface, border and shadow in a stylesheet comes from a
`--terra-*` token in `tokens.css` (documented in `.impeccable/design.json`).
Component stylesheets never hard-code a colour and never repeat a token's value
as a `var()` fallback: `index.css` always loads the tokens first. A one-off
translucent variant of a token is written as
`color-mix(in srgb, var(--terra-…) N%, transparent)`. The only literal left is
the white canvas behind a previewed web page in `preview.css`.

- Surfaces: `--terra-bg`, `-bg-sidebar`, `-bg-panel`, `-bg-elevated`,
  `-bg-hover`, `-bg-menu-hover` (hovered menu item), `-terminal-bg`,
  `-wash-subtle` (barely-there lift), `-scrim` (dialog backdrop),
  `-scrim-soft` (compact drawer backdrop).
- Borders and ink: `--terra-border`, `-border-strong`, `-border-hover`,
  `-border-focus`, `-text`, `-text-secondary`, `-text-muted`, `-text-faint`,
  `-accent`, `-accent-soft`, `-accent-contrast`.
- Focus and elevation: `--terra-focus-ring` (keyboard halo),
  `--terra-pane-focus-ring` (the focused terminal pane), `--terra-shadow-*`.

### Status colours

Green means running, amber means attention, red means failure, and only agent
state uses `--terra-green*`, `--terra-amber*` (`-dim`, `-line`, `-ink`, `-wash`)
and `--terra-red*` (`-dim`, `-ink`, `-line`, `-line-strong`, `-surface`).
Selection, availability, progress and levels are neutral or accent.

A few conventional meanings keep a hue, but always through their own semantic
token, never the status token, so the two can diverge later:

| Meaning | Tokens |
| --- | --- |
| Success notice | `--terra-success` |
| Destructive action | `--terra-danger`, `-danger-ink`, `-danger-dim`, `-danger-line`, `-danger-line-strong` |
| Git diff | `--terra-diff-add`, `-diff-add-dim`, `-diff-del`, `-diff-del-dim`, `-diff-change` |
| Task priority | `--terra-priority-urgent`, `-urgent-ink`, `-urgent-dim`, `--terra-priority-high`, `-high-ink`, `-high-dim` |
