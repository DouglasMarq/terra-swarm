# Terra visual foundation

This directory documents and implements the Terra Swarm visual direction used
by the new orchestration surfaces. It is intentionally independent from the
reference application's branding and assets: the shared pattern is a dense,
terminal-first workspace, while Terra keeps its own zinc surfaces, white
primary action, and green/amber/red status vocabulary.

`index.css` is the single entrypoint. It imports the token, low-specificity
reset, and layout primitives so the host application can adopt the foundation
incrementally. Existing shell styles may continue to coexist during migration.
